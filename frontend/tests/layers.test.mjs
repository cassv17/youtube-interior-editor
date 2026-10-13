import assert from "node:assert/strict";
import test from "node:test";
import {
  activeOverlays, addTrack, canRemoveTrack, defaultTracks, editPoints, fadeFactor, firstFreeStart, fitOnTrack, fitSize,
  isActive, nextPoint, nextTrackId, prevPoint, removeTrack, snapPoint, snapStart, sortTracks, splitOverlay, totalWithLayers, trimOverlay,
} from "../src/layers.ts";

const ov = (id, track, start, dur, extra = {}) => ({
  id, track, type: "video", src: "a", src_in: 0, src_out: dur, dur, start, volume: 1, fade_in: 0, fade_out: 0, ...extra,
});
const ids = (tracks, kind) => tracks.filter((t) => t.kind === kind).map((t) => t.id);

test("기본 트랙: 영상·자막·음성 각각 3개 이상, 영상은 위→아래(V3,V2,V1)", () => {
  const t = defaultTracks();
  assert.deepEqual(ids(t, "video"), ["V3", "V2", "V1"]);
  assert.deepEqual(ids(t, "subtitle"), ["S3", "S2", "S1"]);
  assert.deepEqual(ids(t, "audio"), ["A1", "A2", "A3"]);
  assert.equal(t.find((x) => x.id === "V1").main, true);
});

test("트랙 추가: 영상·자막은 맨 위, 음성은 맨 아래", () => {
  let t = addTrack(defaultTracks(), "video");
  assert.deepEqual(ids(t, "video"), ["V4", "V3", "V2", "V1"]);
  t = addTrack(t, "audio");
  assert.deepEqual(ids(t, "audio"), ["A1", "A2", "A3", "A4"]);
  t = addTrack(t, "subtitle");
  assert.deepEqual(ids(t, "subtitle"), ["S4", "S3", "S2", "S1"]);
  assert.equal(t.map((x) => x.kind).join(), sortTracks(t).map((x) => x.kind).join()); // 종류 순서 유지
  assert.equal(nextTrackId(defaultTracks(), "video"), "V4");
});

test("트랙 삭제: 메인과 최소 3개는 지킨다. 지우면 그 트랙의 항목도 사라진다", () => {
  const t = defaultTracks();
  assert.equal(canRemoveTrack(t, "V1"), false);
  assert.equal(canRemoveTrack(t, "V2"), false);                  // 3개뿐이라 못 지운다
  const t4 = addTrack(t, "video");
  assert.equal(canRemoveTrack(t4, "V4"), true);
  const r = removeTrack(t4, [ov("a", "V4", 0, 2), ov("b", "V2", 0, 2)], "V4");
  assert.deepEqual(ids(r.tracks, "video"), ["V3", "V2", "V1"]);
  assert.deepEqual(r.overlays.map((o) => o.id), ["b"]);
  assert.equal(removeTrack(t, [ov("a", "V2", 0, 1)], "V2").overlays.length, 1);   // 거부되면 그대로
});

test("겹침 방지: 비어 있으면 그대로, 막혀 있으면 가장 가까운 빈자리", () => {
  const others = [{ start: 2, dur: 2 }, { start: 6, dur: 2 }];  // 점유 2~4, 6~8
  assert.equal(fitOnTrack(others, 4.2, 1), 4.2);
  assert.equal(fitOnTrack(others, 3, 1), 4);                    // 2~4에 걸림 → 뒤(4)가 앞(1)보다 가깝다
  assert.equal(fitOnTrack(others, 2.2, 1), 1);                  // 앞(1)이 더 가깝다
  assert.equal(fitOnTrack(others, 5, 3), 8);                    // 3초짜리는 2~4와 6~8 사이(2초)에 안 들어가 뒤(8)로
  assert.equal(fitOnTrack([], -5, 2), 0);                       // 음수는 0으로
  assert.equal(fitOnTrack([{ start: 0, dur: 3 }], 1, 2), 3);    // 맨 앞은 막혀 뒤로
});

test("첫 빈자리 찾기", () => {
  const others = [{ start: 0, dur: 2 }, { start: 3, dur: 2 }];
  assert.equal(firstFreeStart(others, 0, 1), 2);                // 2~3 사이에 들어감
  assert.equal(firstFreeStart(others, 0, 1.5), 5);              // 2~3(1초)엔 안 들어가 뒤로
  assert.equal(firstFreeStart([], 4, 2), 4);
});

test("자석: 시작·끝 가장자리가 가까운 기준점에 붙는다", () => {
  const pts = [0, 5, 10];
  assert.deepEqual(snapStart(0.2, 2, pts, 0.3), { start: 0, snap: 0 });
  assert.deepEqual(snapStart(2.9, 2, pts, 0.3), { start: 3, snap: 5 });      // 끝(4.9)이 5에 붙음
  assert.deepEqual(snapStart(7, 2, pts, 0.3), { start: 7, snap: null });
  assert.deepEqual(snapPoint(5.2, pts, 0.3), { t: 5, snap: 5 });
  assert.deepEqual(snapPoint(6, pts, 0.3), { t: 6, snap: null });
});

test("결과 길이: 숨긴 영상 트랙과 음소거한 음성 트랙은 빠진다", () => {
  const tracks = defaultTracks().map((t) => (t.id === "V3" ? { ...t, hidden: true } : t.id === "A3" ? { ...t, muted: true } : t));
  const items = [ov("a", "V2", 0, 12), ov("b", "V3", 0, 30), ov("c", "A2", 0, 15, { type: "audio" }), ov("d", "A3", 0, 40, { type: "audio" })];
  assert.deepEqual(activeOverlays(tracks, items).map((o) => o.id), ["a", "c"]);
  assert.equal(totalWithLayers(10, tracks, items), 15);
  assert.equal(totalWithLayers(20, tracks, items), 20);
  assert.equal(totalWithLayers(7, tracks, []), 7);
});

test("편집점 이동(↑/↓)", () => {
  const pts = editPoints([0, 4, 8], [ov("a", "V2", 2, 3)], [{ id: "m", t: 6.5, name: "", color: "" }]);
  assert.deepEqual(pts, [0, 2, 4, 5, 6.5, 8]);
  assert.equal(prevPoint(pts, 5), 4);
  assert.equal(nextPoint(pts, 5), 6.5);
  assert.equal(prevPoint(pts, 0), null);
  assert.equal(nextPoint(pts, 8), null);
});

test("페이드 배율과 활성 구간", () => {
  const o = { start: 10, dur: 4, fade_in: 1, fade_out: 2 };
  assert.equal(fadeFactor(o, 10), 0);
  assert.equal(fadeFactor(o, 10.5), 0.5);
  assert.equal(fadeFactor(o, 12), 1);
  assert.equal(fadeFactor(o, 13), 0.5);
  assert.equal(fadeFactor({ start: 0, dur: 4, fade_in: 0, fade_out: 0 }, 2), 1);
  assert.equal(isActive(o, 10), true);
  assert.equal(isActive(o, 14), false);
});

test("화면에 맞춘 크기(contain)", () => {
  assert.deepEqual(fitSize(1, 320, 180), { w: 180, h: 180 });              // 정사각형은 높이에 맞춤
  assert.deepEqual(fitSize(16 / 9, 320, 180), { w: 320, h: 180 });
  assert.deepEqual(fitSize(0.5, 320, 180), { w: 90, h: 180 });
});

test("나누기: 영상은 원본 구간이 이어지고, 이미지는 길이만 나뉜다", () => {
  const v = ov("v", "V2", 4, 6, { src_in: 2, src_out: 8, fade_in: 1, fade_out: 1 });
  const [a, b] = splitOverlay(v, 7, "v2");
  assert.deepEqual([a.start, a.dur, a.src_in, a.src_out, a.fade_in, a.fade_out], [4, 3, 2, 5, 1, 0]);
  assert.deepEqual([b.id, b.start, b.dur, b.src_in, b.src_out, b.fade_in, b.fade_out], ["v2", 7, 3, 5, 8, 0, 1]);
  assert.equal(splitOverlay(v, 4.05, "x"), null);                           // 가장자리에서 너무 가까움
  const img = ov("i", "V2", 0, 4, { type: "image", src_in: 0, src_out: 4 });
  const [i1, i2] = splitOverlay(img, 1.5, "i2");
  assert.deepEqual([i1.dur, i1.src_out, i2.start, i2.dur, i2.src_out], [1.5, 1.5, 1.5, 2.5, 2.5]);
});

test("트림: 원본 길이를 넘지 못하고, 앞으로 늘리면 원본이 앞쪽으로 더 쓰인다", () => {
  const v = ov("v", "V2", 4, 4, { src_in: 3, src_out: 7 });                  // 원본 길이 10
  const r1 = trimOverlay(v, "r", 20, 10);
  assert.deepEqual([r1.dur, r1.src_out], [7, 10]);                           // 원본 끝(10)까지만
  const r2 = trimOverlay(v, "r", 4.04, 10);
  assert.equal(r2.dur, 0.1);                                                  // 최소 길이
  const l1 = trimOverlay(v, "l", 2, 10);
  assert.deepEqual([l1.start, l1.dur, l1.src_in, l1.src_out], [2, 6, 1, 7]);
  const l2 = trimOverlay(v, "l", -5, 10);
  assert.deepEqual([l2.start, l2.src_in], [1, 0]);                           // 원본 처음(3초 앞)까지만
  const l3 = trimOverlay(v, "l", 7.99, 10);
  assert.ok(l3.dur >= 0.1 - 1e-9);
  const img = ov("i", "V2", 2, 3, { type: "image", src_in: 0, src_out: 3 });
  assert.deepEqual([trimOverlay(img, "r", 9, 0).dur, trimOverlay(img, "l", 0.5, 0).start], [7, 0.5]);
});
