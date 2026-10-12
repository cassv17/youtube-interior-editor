import assert from "node:assert/strict";
import test from "node:test";
import { adjacentCut, computePieces, edgeKind, mergedRanges, reviveRange, splitBounds } from "../src/pieces.ts";

const cut = (id, start, end, enabled = true, origin = "silence") => ({ id, start, end, enabled, origin });
const spans = (ps) => ps.map((p) => [p.start, p.end]);

test("컷이 없으면 영상 전체가 한 조각", () => {
  assert.deepEqual(spans(computePieces(10, [], [], [])), [[0, 10]]);
});

test("컷을 뺀 나머지가 조각이 되고, 꺼진 컷은 무시한다", () => {
  const cuts = [cut("a", 2, 3), cut("b", 5, 6, false)];
  assert.deepEqual(spans(computePieces(10, cuts, [], [])), [[0, 2], [3, 10]]);
});

test("겹치는 컷은 합쳐서 계산한다", () => {
  assert.deepEqual(mergedRanges([cut("a", 2, 4), cut("b", 3, 6)]), [[2, 6]]);
});

test("나눈 지점과 클립 경계에서 조각이 쪼개진다", () => {
  const ps = computePieces(10, [cut("a", 4, 5)], [2, 7.5], [6]);
  assert.deepEqual(spans(ps), [[0, 2], [2, 4], [5, 6], [6, 7.5], [7.5, 10]]);
});

test("컷 안에 들어간 나눈 지점과 영상 끝의 지점은 조각을 만들지 않는다", () => {
  const ps = computePieces(10, [cut("a", 4, 6)], [5, 10, 0], []);
  assert.deepEqual(spans(ps), [[0, 4], [6, 10]]);
});

test("1프레임보다 짧은 조각은 버린다", () => {
  const ps = computePieces(10, [cut("a", 2, 5)], [5.01], []);
  assert.deepEqual(spans(ps), [[0, 2], [5, 10]]);
});

test("조각 id는 시작 프레임으로 정해진다", () => {
  const ps = computePieces(10, [cut("a", 2, 3)], [], []);
  assert.deepEqual(ps.map((p) => p.id), ["pc-0", "pc-90"]);
});

test("가장자리 종류: 컷 / 나눈 지점 / 고정", () => {
  const cuts = [cut("a", 4, 5)];
  const splits = [2];
  const ps = computePieces(10, cuts, splits, []);
  const [p0, p1, p2] = ps; // [0,2] [2,4] [5,10]
  assert.equal(edgeKind("l", p0, cuts, splits), "fixed");
  assert.equal(edgeKind("r", p0, cuts, splits), "split");
  assert.equal(edgeKind("l", p1, cuts, splits), "split");
  assert.equal(edgeKind("r", p1, cuts, splits), "cut");
  assert.equal(edgeKind("l", p2, cuts, splits), "cut");
  assert.equal(edgeKind("r", p2, cuts, splits), "fixed");
});

test("컷과 나눈 지점이 같은 자리면 컷이 우선", () => {
  const cuts = [cut("a", 4, 5)];
  const [p0] = computePieces(10, cuts, [4], []);
  assert.equal(edgeKind("r", p0, cuts, [4]), "cut");
});

test("맞닿은 컷 구간 찾기(겹친 컷은 합친 범위)", () => {
  const cuts = [cut("a", 4, 6), cut("b", 5, 7)];
  const ps = computePieces(10, cuts, [], []);
  assert.deepEqual(adjacentCut("l", ps[1], cuts), [4, 7]);
  assert.deepEqual(adjacentCut("r", ps[0], cuts), [4, 7]);
  assert.equal(adjacentCut("l", ps[0], cuts), null);
});

test("되살리기: 컷 안쪽을 일부 걷어 내면 컷이 줄어든다", () => {
  let n = 0;
  const out = reviveRange([cut("a", 4, 8)], 6, 8, () => `n${++n}`);
  assert.deepEqual(out.map((c) => [c.id, c.start, c.end, c.origin]), [["a", 4, 6, "user"]]);
});

test("되살리기: 컷 가운데를 걷어 내면 둘로 나뉘고, 컷 전체를 걷어 내면 사라진다", () => {
  let n = 0;
  const mid = reviveRange([cut("a", 4, 10)], 6, 8, () => `n${++n}`);
  assert.deepEqual(mid.map((c) => [c.id, c.start, c.end]), [["a", 4, 6], ["n1", 8, 10]]);
  const all = reviveRange([cut("a", 4, 10)], 3, 11, () => "x");
  assert.deepEqual(all, []);
});

test("되살리기: 겹친 컷이 있어도 그 범위의 켜진 컷을 모두 걷어 낸다", () => {
  const out = reviveRange([cut("a", 4, 8), cut("b", 5, 7), cut("c", 20, 30), cut("off", 5, 7, false)], 5, 8, () => "n");
  assert.deepEqual(computePiecesOf(out, 40), [[0, 4], [5, 20], [30, 40]]); // 4~5만 컷으로 남는다
  assert.equal(out.find((c) => c.id === "off").enabled, false); // 꺼진 컷은 그대로
});

function computePiecesOf(cuts, duration) {
  return spans(computePieces(duration, cuts, [], []));
}

test("나눈 지점 이동 범위는 양옆 조각이 1프레임 이상 남도록 제한된다", () => {
  const ps = computePieces(10, [], [2, 5], []); // [0,2] [2,5] [5,10]
  const f = 1 / 30;
  assert.deepEqual(splitBounds(ps[1], "l", ps), [0 + f, 5 - f]); // 2에 있는 지점: 0~5 사이
  assert.deepEqual(splitBounds(ps[1], "r", ps), [2 + f, 10 - f]); // 5에 있는 지점: 2~10 사이
});
