import importlib.util
from contextlib import closing
import json
import os
from pathlib import Path
import sqlite3
import tempfile
import time
import unittest
from unittest import mock

spec = importlib.util.spec_from_file_location('retention', Path(__file__).parents[1] / 'ops/retention.py')
r = importlib.util.module_from_spec(spec)
spec.loader.exec_module(r)


class RetentionTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='opentalk-retention-fixture-')
        self.root = Path(self.tmp.name)
        self.layout = r.Layout(*(self.root / name for name in ('app', 'web', 'archive', 'logs', 'legacy.json')))
        for name in ('app', 'web', 'archive', 'logs'):
            (self.root / name).mkdir()
        for name in r.BOT_FILES:
            (self.layout.app / name).write_text('{"synthetic":1}')
        (self.layout.web / 'auth.sqlite.unlink-inbox').mkdir()
        with closing(sqlite3.connect(self.layout.web / 'auth.sqlite')) as db:
            db.execute('create table state (value text)')
            db.execute("insert into state values ('synthetic')")
            db.commit()
        self.layout.legacy.write_text('{"version":1,"files":[]}')
        self.now = time.time()

    def tearDown(self):
        self.assertEqual(self.root.resolve().parent, Path(tempfile.gettempdir()).resolve())
        self.assertTrue(self.root.name.startswith('opentalk-retention-fixture-'))
        self.tmp.cleanup()

    def aged(self, path, days=31):
        os.utime(path, (self.now - days * 86400, self.now - days * 86400))
        return path

    def fresh(self):
        result = r.snapshot(self.layout, self.now)
        return self.layout.archive / result['snapshot']

    def test_sqlite_wal_and_all_json_snapshot(self):
        db = sqlite3.connect(self.layout.web / 'auth.sqlite')
        db.execute('PRAGMA journal_mode=WAL')
        db.execute("insert into state values ('committed WAL')")
        db.commit()
        folder = self.fresh()
        db.close()
        with closing(sqlite3.connect(folder / 'web/auth.sqlite')) as snapshot:
            self.assertEqual(snapshot.execute('select count(*) from state').fetchone()[0], 2)
        self.assertEqual(len(r.validate_bundle(self.layout, folder, self.now)['files']), len(r.BOT_FILES) + 1)

    def test_bracelet_record_database_is_backed_up_and_source_is_preserved(self):
        record = self.layout.web / 'auth.sqlite.bracelet-values.sqlite'
        with closing(sqlite3.connect(record)) as db:
            db.execute('create table records (value real)')
            db.execute('insert into records values (12345.5)')
            db.commit()
        before = record.read_bytes()
        folder = self.fresh()
        with closing(sqlite3.connect(folder / 'web' / record.name)) as copied:
            self.assertEqual(copied.execute('select value from records').fetchone()[0], 12345.5)
        self.assertEqual(record.read_bytes(), before)
        self.assertIn('web/' + record.name, [row['path'] for row in r.validate_bundle(self.layout, folder, self.now)['files']])

    def test_score_record_database_is_backed_up_when_present(self):
        record = self.layout.web / 'auth.sqlite.score-records.sqlite'
        with closing(sqlite3.connect(record)) as db:
            db.execute('create table score_records (score real)')
            db.execute('insert into score_records values (4238.59)')
            db.commit()
        folder = self.fresh()
        with closing(sqlite3.connect(folder / 'web' / record.name)) as copied:
            self.assertEqual(copied.execute('select score from score_records').fetchone()[0], 4238.59)
        self.assertIn('web/' + record.name, [row['path'] for row in r.validate_bundle(self.layout, folder, self.now)['files']])

    def test_homework_and_roster_databases_are_backed_up_when_present(self):
        # 숙제표·원정대 환산 가치·원정대 최고 기록도 영구 기록이다. 전에는 목록에 없어 빠진 채 유효 판정을 받았다.
        names = ('auth.sqlite.homework.sqlite', 'auth.sqlite.roster-values.sqlite', 'auth.sqlite.roster-records.sqlite')
        for index, name in enumerate(names):
            with closing(sqlite3.connect(self.layout.web / name)) as db:
                db.execute('create table records (value integer)')
                db.execute('insert into records values (?)', (index + 1,))
                db.commit()
        folder = self.fresh()
        paths = [row['path'] for row in r.validate_bundle(self.layout, folder, self.now)['files']]
        for index, name in enumerate(names):
            self.assertIn('web/' + name, paths)
            with closing(sqlite3.connect(folder / 'web' / name)) as copied:
                self.assertEqual(copied.execute('select value from records').fetchone()[0], index + 1)

    def test_missing_new_record_in_existing_backup_blocks_cleanup(self):
        self.fresh()
        with closing(sqlite3.connect(self.layout.web / 'auth.sqlite.bracelet-values.sqlite')) as db:
            db.execute('create table records (value real)')
            db.commit()
        old = self.layout.app / 'attendance.json.bak'
        old.write_text('{}')
        self.aged(old)
        with self.assertRaises(r.Refused):
            r.purge(self.layout, self.now)
        self.assertTrue(old.exists())

    def test_dryrun_and_only_fixed_allowlist(self):
        self.fresh()
        bak = self.layout.app / 'attendance.json.bak'
        bak.write_text('{"old":1}')
        self.aged(bak)
        protected = [self.layout.app / 'attendance.json', self.layout.app / '.env.bak',
                     self.layout.logs / 'opentalk-bot-out.log', self.layout.logs / 'admin-audit.log.1']
        for p in protected:
            if not p.exists(): p.write_text('protected')
            self.aged(p)
        before = {str(p): p.read_bytes() for p in [bak, *protected]}
        p = r.plan(self.layout, self.now)
        self.assertEqual([row['path'] for row in p['files']], [str(bak)])
        self.assertEqual(before, {name: Path(name).read_bytes() for name in before})
        self.assertEqual(r.purge(self.layout, self.now)['deletedFiles'], 1)
        self.assertFalse(bak.exists())
        self.assertTrue(all(p.exists() for p in protected))

    def test_no_fresh_backup_means_zero_deletion(self):
        bak = self.layout.app / 'attendance.json.bak'
        bak.write_text('{}')
        self.aged(bak)
        with self.assertRaises(r.Refused): r.purge(self.layout, self.now)
        self.assertTrue(bak.exists())

    def test_expired_managed_bundle_removed_with_new_verified_backup(self):
        old = r.snapshot(self.layout, self.now - 31 * 86400)
        folder = self.layout.archive / old['snapshot']
        for p in folder.rglob('*'):
            if p.is_file(): self.aged(p)
        self.fresh()
        r.purge(self.layout, self.now)
        self.assertFalse(folder.exists())
        self.assertEqual(len(list(self.layout.archive.iterdir())), 1)

    def test_threshold_kept_and_pm2_one_day_margin(self):
        self.fresh()
        for name, days in [('attendance.json.bak', 30), ('user-links.json.bak', 29)]:
            p = self.layout.app / name
            p.write_text('{}')
            self.aged(p, days)
        log = self.layout.logs / 'opentalk-bot-out.log-20260801.gz'
        log.write_bytes(b'synthetic')
        self.aged(log, 29.5)
        self.assertEqual([row['path'] for row in r.plan(self.layout, self.now)['files']], [str(log)])

    def test_tampered_and_extra_backup_contents_block_all_deletion(self):
        folder = self.fresh()
        target = folder / 'bot/attendance.json'
        target.write_text('{}')
        with self.assertRaises(r.Refused): r.plan(self.layout, self.now)
        target.write_text('{"synthetic":1}')
        (folder / 'unknown.json').write_text('{}')
        with self.assertRaises(r.Refused): r.plan(self.layout, self.now)

    def test_incomplete_backup_blocks_new_snapshot(self):
        (self.layout.archive / 'backup-20260101T000000Z').mkdir()
        with self.assertRaises(r.Refused): self.fresh()
        self.assertEqual(len(list(self.layout.archive.iterdir())), 1)

    def test_legacy_metadata_and_path_guards(self):
        folder = self.layout.app / '.before-synthetic' / 'state'
        folder.mkdir(parents=True)
        p = folder / 'attendance.json'
        p.write_text('{}')
        self.aged(p)
        s = p.stat()
        row = {'path': str(p), 'device': s.st_dev, 'inode': s.st_ino, 'size': s.st_size, 'mtimeNs': s.st_mtime_ns}
        self.layout.legacy.write_text(json.dumps({'version': 1, 'files': [row]}))
        self.fresh()
        self.assertEqual([x['path'] for x in r.plan(self.layout, self.now)['files']], [str(p)])
        p.write_text('{"changed":true}')
        with self.assertRaises(r.Refused): r.plan(self.layout, self.now)
        row['path'] = str(self.layout.app / 'attendance.json')
        self.layout.legacy.write_text(json.dumps({'version': 1, 'files': [row]}))
        with self.assertRaises(r.Refused): r.plan(self.layout, self.now)

    def test_hardlinks_and_changed_candidate_rejected(self):
        p = self.layout.app / 'attendance.json.bak'
        p.write_text('{}')
        s = r.stamp(p.stat())
        p.write_text('{"changed":true}')
        with self.assertRaises(r.Refused): r.unlink_checked(p, s)
        os.link(p, self.root / 'hardlink')
        with self.assertRaises(r.Refused): r.checked(p)

    def test_symlink_source_and_parent_rejected(self):
        source = self.root / 'link.json'
        try: source.symlink_to(self.layout.app / 'attendance.json')
        except OSError: self.skipTest('symlink privilege unavailable')
        with self.assertRaises(r.Refused): r.read_bytes(source)
        folder = self.root / 'linkdir'
        folder.symlink_to(self.layout.app, target_is_directory=True)
        with self.assertRaises(r.Refused): r.checked(folder / 'attendance.json')

    def test_inbox_validated_and_unknown_transient_aborts(self):
        inbox = self.layout.web / 'auth.sqlite.unlink-inbox'
        name = 'kakao-' + 'a' * 64 + '.json'
        (inbox / name).write_text('{"synthetic":true}')
        folder = self.fresh()
        self.assertTrue((folder / 'web/inbox' / name).exists())
        (inbox / 'unknown.tmp').write_text('{}')
        with self.assertRaises(r.Refused): r.source_inventory(self.layout)


if __name__ == '__main__':
    unittest.main()
