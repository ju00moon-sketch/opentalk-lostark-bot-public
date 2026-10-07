#!/usr/bin/env python3
"""Bounded local backups and retention. No network or recursive deletion."""
import argparse
import contextlib
import datetime as dt
import hashlib
import json
import os
from pathlib import Path
import re
import sqlite3
import stat
import sys
import time

DAYS = 30
SECONDS = DAYS * 86400
LOG_SECONDS = 29 * 86400  # one daily scheduling interval before the 30 day ceiling
BOT_FILES = (
    'attendance.json', 'user-links.json', 'quip-daily.json',
    'notify-channels.json', 'island-notify.json', 'update-notify.json',
    'merchant-notify.json', 'kakao-update-notify.json', 'meal-daily.json',
)
WEB_DATABASES = (
    'auth.sqlite', 'auth.sqlite.bracelet-values.sqlite', 'auth.sqlite.score-records.sqlite',
    'auth.sqlite.homework.sqlite', 'auth.sqlite.roster-values.sqlite', 'auth.sqlite.roster-records.sqlite',
)
INBOX_FILE = re.compile(r'kakao-[a-f0-9]{64}\.json\Z')
BUNDLE = re.compile(r'backup-\d{8}T\d{6}Z\Z')
PM2_ARCHIVE = re.compile(r'opentalk-bot-(?:out|error)\.log(?:-\d{8}|\.\d+)(?:\.gz)?\Z')


class Refused(RuntimeError):
    pass


class Layout:
    def __init__(self, app='/srv/opentalk',
                 web='/var/lib/opentalk-web', archive='/var/backups/opentalk-retention',
                 logs='/var/log/opentalk', legacy='/etc/opentalk-retention/legacy.json'):
        self.app, self.web, self.archive, self.logs, self.legacy = map(
            Path, (app, web, archive, logs, legacy))


def stamp(s):
    return (s.st_dev, s.st_ino, s.st_size, s.st_mtime_ns, s.st_nlink)


def checked(path, directory=False):
    """Reject links in every component, including roots and missing destinations."""
    path = Path(path)
    if not path.is_absolute() or '..' in path.parts:
        raise Refused('absolute normalized path required')
    for component in reversed([path, *path.parents]):
        try:
            s = component.lstat()
        except FileNotFoundError:
            if component == path:
                return None
            raise Refused('missing parent directory')
        if stat.S_ISLNK(s.st_mode):
            raise Refused('symbolic link rejected')
        if component != path and not stat.S_ISDIR(s.st_mode):
            raise Refused('non-directory parent')
    if directory:
        if not stat.S_ISDIR(s.st_mode):
            raise Refused('directory required')
    elif not stat.S_ISREG(s.st_mode) or s.st_nlink != 1:
        raise Refused('single-link regular file required')
    return s


@contextlib.contextmanager
def parent_fd(path):
    """Pin every directory without following links on the production Linux host."""
    path = Path(path)
    checked(path.parent, directory=True)
    if os.name != 'posix':  # Synthetic tests only; CLI writes require Linux.
        yield None
        return
    fd = os.open('/', os.O_RDONLY | os.O_DIRECTORY)
    try:
        for part in path.parent.parts[1:]:
            nxt = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            os.close(fd)
            fd = nxt
        yield fd
    finally:
        os.close(fd)


def read_bytes(path, limit=128 * 1024 * 1024):
    before = checked(path)
    if before is None or before.st_size > limit:
        raise Refused('missing or oversized file')
    with parent_fd(path) as fd:
        raw_fd = os.open(Path(path).name if fd is not None else path,
                         os.O_RDONLY | getattr(os, 'O_NOFOLLOW', 0), dir_fd=fd)
        with os.fdopen(raw_fd, 'rb') as stream:
            if stamp(os.fstat(stream.fileno())) != stamp(before):
                raise Refused('file changed before read')
            data = stream.read(limit + 1)
            if stamp(os.fstat(stream.fileno())) != stamp(before) or len(data) > limit:
                raise Refused('file changed during read')
    return data


def read_json(path):
    return json.loads(read_bytes(path).decode('utf-8-sig'))


def digest(data):
    return hashlib.sha256(data).hexdigest()


def write_new(path, data):
    if checked(path) is not None:
        raise Refused('destination already exists')
    with parent_fd(path) as fd:
        raw_fd = os.open(Path(path).name if fd is not None else path,
                         os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, 'O_NOFOLLOW', 0),
                         0o600, dir_fd=fd)
        with os.fdopen(raw_fd, 'wb') as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())


def mkdir_new(path):
    if checked(path, directory=True) is not None:
        raise Refused('destination directory already exists')
    path.mkdir(mode=0o700)


def inbox_names(layout):
    inbox = layout.web / 'auth.sqlite.unlink-inbox'
    if checked(inbox, directory=True) is None:
        return []
    names = sorted(p.name for p in inbox.iterdir())
    if any(not INBOX_FILE.fullmatch(n) for n in names):
        raise Refused('unexpected or in-flight inbox file; retry later')
    return names


def source_inventory(layout):
    result = []
    for name in BOT_FILES:
        s = checked(layout.app / name)
        if s:
            result.append({'group': 'bot', 'name': name, 'size': s.st_size})
    for name in ('attendance.json', 'user-links.json'):
        if not any(row['name'] == name for row in result):
            raise Refused('required bot state missing')
    s = checked(layout.web / 'auth.sqlite')
    if s is None:
        raise Refused('web database missing')
    result.append({'group': 'web', 'name': 'auth.sqlite', 'size': s.st_size})
    for name in WEB_DATABASES[1:]:
        s = checked(layout.web / name)
        if s:
            result.append({'group': 'web', 'name': name, 'size': s.st_size})
    result.extend({'group': 'web', 'name': 'inbox/' + name,
                   'size': checked(layout.web / 'auth.sqlite.unlink-inbox' / name).st_size}
                  for name in inbox_names(layout))
    return result


def snapshot(layout, now=None):
    now = time.time() if now is None else now
    inventory = source_inventory(layout)
    if checked(layout.archive, directory=True) is None:
        raise Refused('install the private archive root first')
    # Do not accumulate a new snapshot every day after a failed/interrupted one.
    for existing in layout.archive.iterdir():
        validate_bundle(layout, existing, now)
    target = layout.archive / dt.datetime.fromtimestamp(now, dt.timezone.utc).strftime('backup-%Y%m%dT%H%M%SZ')
    mkdir_new(target)
    mkdir_new(target / 'bot')
    mkdir_new(target / 'web')
    mkdir_new(target / 'web' / 'inbox')
    files = []
    # A failed snapshot remains uncommitted (no manifest) and blocks cleanup until reviewed.
    for row in inventory:
        name = row['name']
        if row['group'] == 'bot':
            data = read_bytes(layout.app / name)
            json.loads(data)
            write_new(target / 'bot' / name, data)
        elif name.startswith('inbox/'):
            data = read_bytes(layout.web / 'auth.sqlite.unlink-inbox' / name[6:])
            json.loads(data)
            write_new(target / 'web' / name, data)
    for name in WEB_DATABASES:
        if not any(row['group'] == 'web' and row['name'] == name for row in inventory):
            continue
        db = layout.web / name
        before = checked(db)
        # SQLite's backup API includes committed WAL transactions; a file copy does not.
        with contextlib.closing(sqlite3.connect(db.as_uri() + '?mode=ro', uri=True, timeout=10)) as source:
            with contextlib.closing(sqlite3.connect(target / 'web' / name)) as dest:
                deadline = time.monotonic() + 60
                def progress(status, remaining, total):
                    if time.monotonic() > deadline:
                        raise Refused('database backup deadline exceeded')
                source.backup(dest, pages=256, progress=progress, sleep=0.05)
                if dest.execute('PRAGMA journal_mode=DELETE').fetchone() != ('delete',):
                    raise Refused('standalone database journal mode failed')
                if dest.execute('PRAGMA quick_check').fetchall() != [('ok',)]:
                    raise Refused('database integrity check failed')
        os.chmod(target / 'web' / name, 0o600)
        after = checked(db)
        if (before.st_dev, before.st_ino) != (after.st_dev, after.st_ino):
            raise Refused('database replaced during snapshot')
    if inbox_names(layout) != sorted(row['name'][6:] for row in inventory if row['name'].startswith('inbox/')):
        raise Refused('unlink inbox changed during snapshot; retry')
    for row in inventory:
        if row['name'].startswith('inbox/') and read_bytes(
                layout.web / 'auth.sqlite.unlink-inbox' / row['name'][6:]) != read_bytes(target / 'web' / row['name']):
            raise Refused('unlink inbox content changed during snapshot; retry')
    for row in inventory:
        relative = row['group'] + '/' + row['name']
        data = read_bytes(target / relative)
        files.append({'path': relative, 'size': len(data), 'sha256': digest(data)})
    manifest = {'version': 1, 'createdAt': now, 'files': files}
    write_new(target / 'manifest.json', json.dumps(manifest, sort_keys=True, indent=2).encode())
    validate_bundle(layout, target, now)
    return {'snapshot': target.name, 'files': len(files), 'bytes': sum(f['size'] for f in files)}


def allowed_relative(name):
    return name in {'bot/' + n for n in BOT_FILES} or name in {'web/' + n for n in WEB_DATABASES} or (
        name.startswith('web/inbox/') and INBOX_FILE.fullmatch(name[10:]) is not None)


def validate_bundle(layout, folder, now):
    if folder.parent != layout.archive or not BUNDLE.fullmatch(folder.name):
        raise Refused('unrecognized backup directory')
    checked(folder, directory=True)
    m = read_json(folder / 'manifest.json')
    date = dt.datetime.strptime(folder.name, 'backup-%Y%m%dT%H%M%SZ').replace(tzinfo=dt.timezone.utc).timestamp()
    if m.get('version') != 1 or not isinstance(m.get('createdAt'), (int, float)) or abs(m['createdAt'] - date) >= 1 or date > now:
        raise Refused('invalid backup timestamp')
    files = m.get('files')
    if not isinstance(files, list) or len(files) > 10000:
        raise Refused('invalid backup manifest')
    names = [f['path'] for f in files]
    if len(names) != len(set(names)) or any(not allowed_relative(n) for n in names):
        raise Refused('unapproved backup file')
    if not {'bot/attendance.json', 'bot/user-links.json', 'web/auth.sqlite'} <= set(names):
        raise Refused('incomplete backup')
    expected = {'manifest.json', *names}
    actual = set()
    for base, dirs, entries in os.walk(folder, followlinks=False):
        for name in dirs:
            p = Path(base) / name
            checked(p, directory=True)
            if p.relative_to(folder).as_posix() not in {'bot', 'web', 'web/inbox'}:
                raise Refused('unexpected backup directory')
        for name in entries:
            actual.add((Path(base) / name).relative_to(folder).as_posix())
    if actual != expected:
        raise Refused('backup contents differ from manifest')
    for row in files:
        data = read_bytes(folder / row['path'])
        if row['size'] != len(data) or row['sha256'] != digest(data):
            raise Refused('backup hash mismatch')
    return m


def legacy_paths(layout):
    # Only reviewed exact paths are admitted. No pattern-based legacy discovery on daily runs.
    manifest = read_json(layout.legacy)
    if manifest.get('version') != 1 or not isinstance(manifest.get('files'), list):
        raise Refused('invalid legacy inventory')
    paths = []
    for row in manifest['files']:
        p = Path(row['path'])
        app_relative = None
        try:
            app_relative = p.relative_to(layout.app)
        except ValueError:
            pass
        app_ok = (app_relative is not None and len(app_relative.parts) in (2, 3)
                  and app_relative.parts[0].startswith('.before-')
                  and p.name.removesuffix('.bak') in BOT_FILES)
        web_ok = (p.name in {'auth.sqlite', 'auth.sqlite-wal', 'auth.sqlite-shm'}
                  and p.parent.name == 'state'
                  and p.parent.parent.parent in {
                      Path('/var/backups/opentalk-web-owner'),
                      Path('/var/backups/opentalk-web-upgrade')})
        if not (app_ok or web_ok) or not p.is_absolute() or '..' in p.parts:
            raise Refused('legacy inventory path outside approved data snapshots')
        s = checked(p)
        if s and (s.st_dev, s.st_ino, s.st_size, s.st_mtime_ns) != (
                row.get('device'), row.get('inode'), row.get('size'), row.get('mtimeNs')):
            raise Refused('legacy snapshot changed since inventory; review again')
        paths.append(p)
    if len(paths) != len(set(paths)):
        raise Refused('duplicate legacy inventory path')
    return paths


def plan(layout, now=None):
    now = time.time() if now is None else now
    cutoff = now - SECONDS
    checked(layout.archive, directory=True)
    bundles = []
    fresh = []
    for folder in sorted(layout.archive.iterdir()):
        m = validate_bundle(layout, folder, now)
        bundles.append((folder, m))
        # All currently present state types must have a verified fresh replacement.
        required = {r['group'] + '/' + r['name'] for r in source_inventory(layout)}
        if m['createdAt'] >= cutoff and required <= {r['path'] for r in m['files']}:
            fresh.append(folder.name)
    if not fresh:
        raise Refused('no complete verified backup within 30 days; deletion stopped')
    candidates = []
    def consider(p, kind, expires=cutoff):
        s = checked(p)
        if s and s.st_mtime < expires:
            candidates.append({'path': str(p), 'kind': kind, 'size': s.st_size, 'stamp': stamp(s)})
    for name in BOT_FILES:
        consider(layout.app / (name + '.bak'), 'fixed-bak')
    for p in legacy_paths(layout):
        consider(p, 'legacy-data')
    expired_bundles = []
    for folder, m in bundles:
        if m['createdAt'] < cutoff:
            paths = [folder / r['path'] for r in m['files']] + [folder / 'manifest.json']
            if all(checked(p).st_mtime < cutoff for p in paths):
                for p in paths:
                    consider(p, 'managed-backup')
                expired_bundles.append(str(folder))
    checked(layout.logs, directory=True)
    for p in sorted(layout.logs.iterdir()):
        if PM2_ARCHIVE.fullmatch(p.name):
            consider(p, 'pm2-archive', now - LOG_SECONDS)
    return {'version': 1, 'cutoff': cutoff, 'freshBackups': fresh,
            'files': candidates, 'emptyBundles': expired_bundles}


def unlink_checked(path, expected):
    path = Path(path)
    if stamp(checked(path)) != tuple(expected):
        raise Refused('candidate changed after plan')
    with parent_fd(path) as fd:
        s = os.stat(path.name if fd is not None else path, dir_fd=fd, follow_symlinks=False)
        if stamp(s) != tuple(expected) or not stat.S_ISREG(s.st_mode) or s.st_nlink != 1:
            raise Refused('candidate changed before unlink')
        os.unlink(path.name if fd is not None else path, dir_fd=fd)


def purge(layout, now=None):
    p = plan(layout, now)
    # Validate every candidate before the first deletion; each is rechecked at unlink.
    for row in p['files']:
        if stamp(checked(row['path'])) != row['stamp']:
            raise Refused('candidate changed after plan')
    for row in p['files']:
        unlink_checked(row['path'], row['stamp'])
    # rmdir only succeeds for empty managed directories; never recurse.
    for name in p['emptyBundles']:
        folder = Path(name)
        for pth in (folder / 'web' / 'inbox', folder / 'web', folder / 'bot', folder):
            checked(pth, directory=True)
            with parent_fd(pth) as fd:
                os.rmdir(pth.name if fd is not None else pth, dir_fd=fd)
    return {'deletedFiles': len(p['files']), 'deletedBytes': sum(f['size'] for f in p['files'])}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('command', choices=('inventory', 'plan', 'snapshot', 'daily'))
    parser.add_argument('--apply', action='store_true', help='explicitly enable snapshot/cleanup writes')
    args = parser.parse_args()
    if args.apply and (args.command not in ('snapshot', 'daily') or os.name != 'posix' or os.geteuid() != 0):
        parser.error('--apply requires root on Linux and snapshot/daily')
    layout = Layout()
    try:
        if args.command == 'inventory' or (args.command == 'snapshot' and not args.apply):
            result = {'dryRun': True, 'sources': source_inventory(layout),
                      'legacyFiles': len(legacy_paths(layout))}
        elif args.command in ('plan', 'daily') and not args.apply:
            result = {'dryRun': True, **plan(layout)}
        else:
            import fcntl
            # Root-owned /run lock prevents overlapping scheduled/manual writes.
            with open('/run/opentalk-retention.lock', 'a') as lock:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                result = snapshot(layout)
                if args.command == 'daily':
                    result.update(purge(layout))
        print(json.dumps(result, sort_keys=True))
    except Exception as exc:
        # JSON/SQLite exceptions can contain input snippets. Print type only for those.
        message = str(exc) if isinstance(exc, Refused) else type(exc).__name__
        print(json.dumps({'ok': False, 'error': message}), file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
