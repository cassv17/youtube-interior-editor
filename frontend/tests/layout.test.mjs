import assert from "node:assert/strict";
import test from "node:test";
import {
  atomsOf, cleanSpeeds, eToP, isDefaultLayout, moveItem, nextItemAfter, placeItems, pToE, reconcile, setGap, subInstances,
} from "../src/layout.ts";

const it = (id, a, b, gap = 0) => ({ id, a, b, gap });
const near = (x, y, msg) => assert.ok(Math.abs(x - y) < 1e-6, `${msg ?? ""} ${x} != ${y}`);
const pos = (items, speeds = []) => placeItems(items, speeds).placed.map((p) => [p.id, +p.e0.toFixed(4), +p.e1.toFixed(4)]);

test("배치 계산: 빈칸이 없으면 길이를 이어 붙인다", () => {
  assert.deepEqual(pos([it("a", 0, 2), it("b", 5, 8)]), [["a", 0, 2], ["b", 2, 5]]);
});

test("배치 계산: 앞 빈칸과 첫 조각 앞 빈칸", () => {
  assert.deepEqual(pos([it("a", 0, 2, 1), it("b", 5, 8, 0.5)]), [["a", 1, 3], ["b", 3.5, 6.5]]);
});

test("배속은 길이를 프레임 정수로 바꾼다 (원본 N프레임 → round(N/배속))", () => {
  const sp = [{ start: 2, end: 4, speed: 2 }];
  // 0~6: 0~2(1배) + 2~4(2배 → 1초) + 4~6(1배)
  assert.deepEqual(pos([it("a", 0, 6)], sp), [["a", 0, 5]]);
  const atoms = atomsOf({ a: 0, b: 6 }, cleanSpeeds(sp), 0);
  assert.deepEqual(atoms.map((x) => [x.a, x.b, x.speed, x.e0, x.e1]), [[0, 2, 1, 0, 2], [2, 4, 2, 2, 3], [4, 6, 1, 3, 5]]);
  // 0.5배속 느린 화면은 길어진다
  assert.deepEqual(pos([it("a", 0, 2)], [{ start: 0, end: 2, speed: 0.5 }]), [["a", 0, 4]]);
});

test("원본 시간 ↔ 결과 시간 변환 (배속·빈칸 포함)", () => {
  const items = [it("a", 10, 14, 1), it("b", 0, 2, 1)];
  const { placed } = placeItems(items, [{ start: 10, end: 14, speed: 2 }]);
  near(pToE(placed, 12), 1 + 1);       // a는 1초 뒤 시작, 2배속이라 12는 1초 지점
  near(pToE(placed, 1), 1 + 2 + 1 + 1); // b는 a 끝(3) + 빈칸 1 = 4초 시작
  assert.equal(pToE(placed, 5), null);
  const hit = eToP(placed, 2);
  assert.equal(hit.item.id, "a");
  near(hit.p, 12);
  assert.equal(eToP(placed, 0.5), null);  // 첫 조각 앞 빈칸
  assert.equal(eToP(placed, 3.5), null);  // a와 b 사이 빈칸
  assert.equal(eToP(placed, 99), null);
  assert.equal(nextItemAfter(placed, 3.5).id, "b");
  assert.equal(nextItemAfter(placed, 5), null);
});

test("기본 배치 판정", () => {
  assert.equal(isDefaultLayout([it("a", 0, 1), it("b", 2, 3)]), true);
  assert.equal(isDefaultLayout([it("a", 0, 1), it("b", 2, 3, 0.5)]), false);
  assert.equal(isDefaultLayout([it("b", 2, 3), it("a", 0, 1)]), false);
});

// ---- reconcile ----
const pc = (a, b) => ({ a, b });
const flat = (items) => items.map((x) => [x.id, x.a, x.b, +x.gap.toFixed(3)]);

test("reconcile: 기존 배치가 없으면 원본 순서로 이어 붙인다", () => {
  assert.deepEqual(flat(reconcile([], [pc(0, 2), pc(5, 8)])), [["pc-0", 0, 2, 0], ["pc-150", 5, 8, 0]]);
});

test("reconcile: 같은 구간이면 아무것도 바뀌지 않는다(멱등)", () => {
  const cur = [it("x", 5, 8, 1), it("y", 0, 2, 0.5)];
  assert.deepEqual(reconcile(cur, [pc(0, 2), pc(5, 8)]), cur);
});

test("reconcile: 조각을 나누면 둘이 원래 자리에 이어 놓이고 앞 조각이 id를 지킨다", () => {
  const cur = [it("x", 5, 8, 1), it("y", 0, 2, 0.5)];
  const r = reconcile(cur, [pc(0, 2), pc(5, 6), pc(6, 8)]);
  assert.deepEqual(flat(r).map((v) => v.slice(1)), [[5, 6, 1], [6, 8, 0], [0, 2, 0.5]]);
  assert.equal(r[1].id, "x"); // [6,8]이 [5,8]과 가장 많이 겹쳐 id를 이어받고, [5,6]은 새 id를 받는다
  assert.equal(r[0].id, "pc-150");
  assert.equal(new Set(r.map((v) => v.id)).size, 3);
});

test("reconcile: 끝을 늘리거나 줄여도 id·빈칸이 유지된다", () => {
  const cur = [it("x", 5, 8, 1), it("y", 0, 2, 0.5)];
  assert.deepEqual(flat(reconcile(cur, [pc(0, 2), pc(4, 8)])).slice(0, 1), [["x", 4, 8, 1]]);
  assert.deepEqual(flat(reconcile(cur, [pc(0, 2), pc(5, 7)])).slice(0, 1), [["x", 5, 7, 1]]);
});

test("reconcile: 조각이 지워지면 그 앞 빈칸은 다음 조각이 이어받는다", () => {
  const cur = [it("x", 5, 8, 1), it("y", 0, 2, 0.5), it("z", 10, 12, 0.25)];
  const r = reconcile(cur, [pc(0, 2), pc(10, 12)]); // x 삭제
  assert.deepEqual(flat(r), [["y", 0, 2, 1.5], ["z", 10, 12, 0.25]]);
});

test("reconcile: 컷이 사라져 두 조각이 하나로 합쳐지면 앞선 조각 자리에 놓인다", () => {
  const cur = [it("y", 6, 10, 1), it("x", 0, 4, 0)]; // E 순서가 뒤바뀐 상태
  const r = reconcile(cur, [pc(0, 10)]);
  assert.equal(r.length, 1);
  assert.equal(r[0].id, "y"); // 겹침이 같으면 E 순서가 앞선 쪽(y)이 이긴다
});

test("reconcile: 새로 살아난 구간은 원본에서 바로 앞 조각 뒤에 놓인다", () => {
  const cur = [it("x", 6, 8, 0), it("y", 0, 2, 0)];
  const r = reconcile(cur, [pc(0, 2), pc(3, 4), pc(6, 8)]);
  assert.deepEqual(flat(r).map((v) => [v[1], v[2]]), [[6, 8], [0, 2], [3, 4]]);
});

// ---- 이동 ----
const mv = (items, id, x, magnet, extra = {}) => moveItem(items, [], id, x, { magnet, threshold: 0.3, ...extra });
const abs = (items) => pos(items.items ?? items);

test("이동(자석 끔): 원하는 위치에 두면 앞에 빈칸이 생긴다", () => {
  const r = mv([it("a", 0, 2), it("b", 5, 8)], "b", 6.2, false);
  assert.deepEqual(abs(r), [["a", 0, 2], ["b", 6.2, 9.2]]);
  assert.equal(r.snap, null);
});

test("이동(자석 끔): 가까워도 붙지 않는다", () => {
  const r = mv([it("a", 0, 2), it("b", 5, 8)], "b", 2.1, false);
  near(placeItems(r.items, []).placed[1].e0, 2.1);
});

test("이동(자석 켬): 옆 조각 끝에 가까우면 정확히 붙는다", () => {
  const r = mv([it("a", 0, 2), it("b", 5, 8)], "b", 2.2, true);
  near(placeItems(r.items, []).placed[1].e0, 2);
  near(r.snap, 2);
  assert.deepEqual(r.items.map((x) => x.gap), [0, 0]);
});

test("이동(자석 켬): 조각 오른쪽 가장자리도 다른 조각 시작에 붙는다", () => {
  const items = [it("a", 0, 2), it("b", 5, 8, 4)]; // b: 6~9
  const r = mv(items, "a", 3.1, true); // a(길이 2)의 끝 5.1 → b 시작 6에 붙지 않음(거리 0.9), 시작 3.1 → 붙을 곳 없음
  near(placeItems(r.items, []).placed.find((p) => p.id === "a").e0, 3.1);
  const r2 = mv(items, "a", 3.9, true); // 끝 5.9 → 6에 붙어 시작은 4
  near(placeItems(r2.items, []).placed.find((p) => p.id === "a").e0, 4);
  near(r2.snap, 6);
});

test("이동(자석 켬): 0초와 재생 위치에도 붙는다", () => {
  const r = mv([it("a", 0, 2, 3)], "a", 0.2, true);
  near(placeItems(r.items, []).placed[0].e0, 0);
  const r2 = mv([it("a", 0, 2, 3)], "a", 5.1, true, { playhead: 5 });
  near(placeItems(r2.items, []).placed[0].e0, 5);
});

test("이동: 다른 조각 위로 겹쳐 놓으면 순서를 바꾸고 뒤 조각이 밀려난다", () => {
  const items = [it("a", 0, 2), it("b", 5, 8), it("c", 10, 12)]; // a 0~2, b 2~5, c 5~7
  const r = mv(items, "a", 3.5, false); // a 중심 4.5 → b 중심 3.5 뒤, c 중심 6 앞
  assert.deepEqual(r.items.map((x) => x.id), ["b", "a", "c"]);
  const p = placeItems(r.items, []).placed.map((q) => [q.id, q.e0, q.e1]);
  assert.deepEqual(p[0], ["b", 2, 5]);       // b는 원래 위치(2~5)를 지킨다
  near(p[1][1], 5);                          // a는 b와 겹칠 수 없어 5에 놓인다
  near(p[2][1], 7);                          // c는 밀려난다
});

test("이동: 빠진 자리는 빈칸으로 남고 뒤 조각은 제자리를 지킨다", () => {
  const items = [it("a", 0, 2), it("b", 5, 8), it("c", 10, 12)]; // a 0~2, b 2~5, c 5~7
  const r = mv(items, "b", 20, false);
  assert.deepEqual(r.items.map((x) => x.id), ["a", "c", "b"]);
  const p = placeItems(r.items, []).placed;
  assert.deepEqual(p.map((q) => [q.id, q.e0, q.e1]), [["a", 0, 2], ["c", 5, 7], ["b", 20, 23]]);
});

test("이동: 0보다 앞으로는 못 간다", () => {
  const r = mv([it("a", 0, 2, 4)], "a", -3, false);
  near(placeItems(r.items, []).placed[0].e0, 0);
});

test("빈칸 직접 지정", () => {
  const r = setGap([it("a", 0, 2), it("b", 5, 8)], "b", 1.5);
  assert.deepEqual(pos(r), [["a", 0, 2], ["b", 3.5, 6.5]]);
  assert.equal(setGap(r, "b", -3)[1].gap, 0);
});

// ---- 자막 ----
test("자막: 조각을 따라 이동한다", () => {
  const items = [it("b", 5, 8), it("a", 0, 2)]; // 순서가 바뀐 배치: b 0~3, a 3~5
  const { placed } = placeItems(items, []);
  const subs = [{ id: "s1", start: 1, end: 1.5, text: "a 안" }, { id: "s2", start: 6, end: 7, text: "b 안" }];
  const inst = subInstances(placed, subs);
  assert.deepEqual(inst.map((i) => [i.id, i.e0, i.e1]), [["s2", 1, 2], ["s1", 4, 4.5]]);
});

test("자막: 두 조각에 걸치면 둘로 나뉘고, 이어 붙어 있으면 하나로 합쳐진다", () => {
  const sub = [{ id: "s", start: 1, end: 6, text: "길다" }];
  const apart = subInstances(placeItems([it("a", 0, 2, 0), it("b", 5, 8, 2)], []).placed, sub);
  assert.deepEqual(apart.map((i) => [i.e0, i.e1]), [[1, 2], [4, 5]]);   // a 끝(2) ~ 빈칸 2 ~ b(4~7)의 5~6 구간
  const joined = subInstances(placeItems([it("a", 0, 2, 0), it("b", 5, 8, 0)], []).placed, sub);
  assert.deepEqual(joined.map((i) => [i.e0, i.e1]), [[1, 3]]);          // 1~2 + 2~3
});

test("자막: 분리된(free) 자막은 결과 시간에 고정된다", () => {
  const { placed } = placeItems([it("b", 5, 8), it("a", 0, 2)], []);
  const inst = subInstances(placed, [{ id: "f", start: 0, end: 1, text: "자유", free: true, e_start: 9, e_end: 10 }]);
  assert.deepEqual(inst.map((i) => [i.id, i.e0, i.e1, i.free]), [["f", 9, 10, true]]);
});

test("자막: 배속 구간에서는 결과 시간이 줄어든다", () => {
  const { placed } = placeItems([it("a", 0, 6)], [{ start: 2, end: 4, speed: 2 }]);
  const inst = subInstances(placed, [{ id: "s", start: 2, end: 4, text: "빠름" }, { id: "t", start: 4, end: 5, text: "뒤" }]);
  assert.deepEqual(inst.map((i) => [i.id, i.e0, i.e1]), [["s", 2, 3], ["t", 3, 4]]);
});

test("자막: 위 레이어로 올린 조각(extra)이 자막을 함께 가져간다", () => {
  const { placed } = placeItems([it("a", 0, 2)], []);                          // 메인에는 원본 0~2초만 남음
  const extra = [{ a: 6, b: 10, e0: 20, e1: 24 }];                              // 원본 6~10초가 결과 20초로 올라감
  const subs = [{ id: "s1", start: 1, end: 1.5, text: "메인" }, { id: "s2", start: 7, end: 8, text: "올린 조각" }];
  assert.deepEqual(subInstances(placed, subs, extra).map((i) => [i.id, i.e0, i.e1]), [["s1", 1, 1.5], ["s2", 21, 22]]);
  assert.deepEqual(subInstances(placed, subs).map((i) => i.id), ["s1"]);       // 가져가지 않으면 사라진다
});

test("긴 조각도 마우스가 앞 조각 중심을 넘으면 앞으로 순서가 바뀐다", () => {
  const items = [it("p1", 0, 0.4), it("p2", 0.4, 4.8), it("p3", 4.8, 11.6)];
  // 조각 중심 기준으로는 0초에 막혀 앞으로 갈 수 없었다
  assert.deepEqual(moveItem(items, [], "p3", 0, { magnet: false, threshold: 0 }).items.map((x) => x.id), ["p1", "p2", "p3"]);
  const r = moveItem(items, [], "p3", 0, { magnet: false, threshold: 0, pointer: 1 });
  assert.deepEqual(r.items.map((x) => x.id), ["p1", "p3", "p2"]);
  const r2 = moveItem(items, [], "p3", 0, { magnet: false, threshold: 0, pointer: 0.1 });
  assert.deepEqual(r2.items.map((x) => x.id), ["p3", "p1", "p2"]);
});
