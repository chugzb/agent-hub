// B3：语言服务的 pid / 令牌 / 端口要缓存，别每次调用都跑 ps + lsof；调不通再重新找。
// 全部注入假的 scan / alive / now 和假 fetch，不跑真的 ps、lsof，也不真的连桌面端。
import test from "node:test";
import assert from "node:assert/strict";

const D = await import("../desk.mjs");

/** 假的 ps + lsof：每次 scan 换一组端口，方便看出重新找过几回 */
const mkDeps = (o = {}) => {
  const st = { scans: 0 };
  let next = o.info ?? { pid: "4321", csrf: "tok-1", ports: [50100, 50101] };
  return {
    st,
    deps: {
      scan: () => { st.scans++; if (o.scanError) throw new Error(o.scanError); return next; },
      alive: () => o.alive ?? true,
      now: () => o.now ?? 1_000_000,
    },
    /** 改下一轮 scan 返回什么（模拟桌面端重启换了 pid 和端口） */
    setInfo: (x) => { next = x; },
  };
};

test("lsInfo：五分钟内、pid 还活着就用缓存，不重跑 ps + lsof", () => {
  D._resetLsInfoCache();
  let now = 1_000_000;
  const h = mkDeps({ now: 1_000_000 });
  const deps = { ...h.deps, now: () => now };
  assert.deepEqual(D.lsInfo({ _deps: deps }), { pid: "4321", csrf: "tok-1", ports: [50100, 50101] });
  now += 4 * 60_000;
  assert.deepEqual(D.lsInfo({ _deps: deps }), { pid: "4321", csrf: "tok-1", ports: [50100, 50101] });
  assert.equal(h.st.scans, 1, "连续两次只用一次 ps+lsof");
});

test("lsInfo：超过五分钟、pid 没了、force 都要重新找", () => {
  D._resetLsInfoCache();
  let now = 1_000_000, alive = true;
  const h = mkDeps();
  const deps = { scan: h.deps.scan, alive: () => alive, now: () => now };

  D.lsInfo({ _deps: deps });
  now += 5 * 60_000;                       // 正好到 5 分钟：重新找
  D.lsInfo({ _deps: deps });
  assert.equal(h.st.scans, 2, "过期要重新找");

  D.lsInfo({ _deps: deps });
  assert.equal(h.st.scans, 2, "没过期还是用缓存");
  h.setInfo({ pid: "9999", csrf: "tok-2", ports: [50200] });
  alive = false;                           // 桌面端重启了，旧 pid 没了
  assert.deepEqual(D.lsInfo({ _deps: deps }), { pid: "9999", csrf: "tok-2", ports: [50200] });
  assert.equal(h.st.scans, 3, "pid 没了要重新找");

  alive = true;
  D.lsInfo({ _deps: deps });
  assert.equal(h.st.scans, 3, "新结果进缓存");
  h.setInfo({ pid: "9998", csrf: "tok-3", ports: [50300] });
  D.lsInfo({ force: true, _deps: deps });
  assert.equal(h.st.scans, 4, "force 直接重新找");
});

test("lsInfo：缓存返回的是副本，改调用方的 ports 不会污染缓存", () => {
  D._resetLsInfoCache();
  const h = mkDeps();
  const a = D.lsInfo({ _deps: h.deps });
  a.ports.push(1);
  assert.deepEqual(D.lsInfo({ _deps: h.deps }).ports, [50100, 50101]);
});

test("lsInfo：找不到桌面端就报错，缓存清空，下次还重新找", () => {
  D._resetLsInfoCache();
  const ok = mkDeps();
  D.lsInfo({ _deps: ok.deps });
  const bad = mkDeps({ scanError: "反重力桌面端没在运行" });
  assert.throws(() => D.lsInfo({ force: true, _deps: bad.deps }), /反重力桌面端没在运行/);
  const again = mkDeps();
  D.lsInfo({ _deps: again.deps });
  assert.equal(again.st.scans, 1, "上次扫描失败不能留着旧缓存");
});

test("call：端口调不通就强制重新找一遍，用新端口重试", async () => {
  D._resetLsInfoCache();
  const h = mkDeps({ info: { pid: "4321", csrf: "tok-1", ports: [50100] } });
  D.lsInfo({ _deps: h.deps });   // 先让缓存里装着旧端口
  let fetched = 0;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    fetched++;
    if (String(url).includes(":50100/")) throw new Error("ECONNREFUSED");
    return { ok: true, status: 200, text: async () => JSON.stringify({ hello: "world" }) };
  };
  h.setInfo({ pid: "5555", csrf: "tok-2", ports: [50200] });   // 桌面端换了端口
  try {
    const r = await D.call("GetAllCascadeTrajectories", {}, { _deps: h.deps });
    assert.deepEqual(r, { port: 50200, data: { hello: "world" } });
    assert.equal(h.st.scans, 2, "第一次用缓存里的旧端口，失败后重新找");
    assert.equal(fetched, 2);
  } finally { globalThis.fetch = realFetch; }
});

test("call：两轮都调不通 → 报错带上每次失败原因，并且清缓存", async () => {
  D._resetLsInfoCache();
  const h = mkDeps();
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error("ECONNREFUSED"); };
  try {
    await assert.rejects(() => D.call("X", {}, { _deps: h.deps }), (e) => {
      assert.match(e.message, /调不通/);
      assert.match(e.message, /50100 ECONNREFUSED/);
      assert.match(e.message, /50101 ECONNREFUSED/);
      return true;
    });
    assert.equal(h.st.scans, 2, "两轮各找一次");
  } finally { globalThis.fetch = realFetch; }

  // 再调一次：缓存已清，必须重新找，不能拿旧端口瞎试
  h.setInfo({ pid: "7777", csrf: "tok-3", ports: [50400] });
  const okFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, status: 200, text: async () => "" });
  try {
    const r = await D.call("X", {}, { _deps: h.deps });
    assert.equal(r.port, 50400);
    assert.equal(h.st.scans, 3);
  } finally { globalThis.fetch = okFetch; }
});
