import { once } from 'node:events';
import { createServer } from 'node:net';

// 빈 포트를 찾아 바로 붙잡는다. probe를 닫는 사이 다른 시험이 같은 번호를 채 갈 수 있으므로
// **EADDRINUSE만** 받아 다시 시도하고 다른 오류는 그대로 올린다.
//
// once(server, 'listening')은 server의 error 사건에서 거절한다. 그래서 Promise.race로 묶으면
// 첫 Promise가 먼저 거절해 재시도 분기에 닿지 못한다 — 두 사건을 한 Promise 안에서 받아야 한다.
export async function listenOnFreePort(start, { attempts = 10 } = {}) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    const probe = createServer();
    probe.listen(0, '127.0.0.1');
    await once(probe, 'listening');
    const port = probe.address().port;
    await new Promise((resolve) => probe.close(resolve));

    const server = start(port);
    const started = await new Promise((resolve, reject) => {
      const onListening = () => { server.off('error', onError); resolve(true); };
      const onError = (error) => {
        server.off('listening', onListening);
        if (error?.code === 'EADDRINUSE') resolve(false);
        else reject(error);
      };
      server.once('listening', onListening);
      server.once('error', onError);
    });
    if (started) return { server, port };
    await new Promise((resolve) => server.close(resolve));
  }
  throw new Error('빈 포트를 찾지 못했습니다');
}
