/**
 * Seat and door maths for the 3D floor. The head-seat ordering in particular
 * is load-bearing: the moderator is always participant 0, and the cross-office
 * coordination path seats two agents at seats[0] and seats[1] expecting them
 * to face each other across the table.
 */

import { describe, it, expect } from "bun:test";
import {
  meetingRoomDoorPoint,
  getMeetingSeatPositions,
  sameOffice,
  pickFreeChair,
  type RoomBox,
} from "./office-geometry.js";

const room: RoomBox = { cx: 0, cz: 0, w: 10, d: 8 };

describe("meetingRoomDoorPoint", () => {
  it("picks the wall midpoint nearest the hall", () => {
    expect(meetingRoomDoorPoint(room, { x: 0, z: 50 })).toEqual({ x: 0, y: 0, z: 4 });
    expect(meetingRoomDoorPoint(room, { x: 0, z: -50 })).toEqual({ x: 0, y: 0, z: -4 });
    expect(meetingRoomDoorPoint(room, { x: -50, z: 0 })).toEqual({ x: -5, y: 0, z: 0 });
    expect(meetingRoomDoorPoint(room, { x: 50, z: 0 })).toEqual({ x: 5, y: 0, z: 0 });
  });

  it("always lands on the floor plane", () => {
    expect(meetingRoomDoorPoint(room, { x: 7, z: 3 }).y).toBe(0);
  });
});

describe("getMeetingSeatPositions", () => {
  it("puts the two head seats first, facing each other", () => {
    const seats = getMeetingSeatPositions(room);
    expect(seats[0].z).toBe(room.cz);
    expect(seats[1].z).toBe(room.cz);
    expect(seats[0].x).toBeLessThan(room.cx);
    expect(seats[1].x).toBeGreaterThan(room.cx);
  });

  it("then fills both long sides", () => {
    const seats = getMeetingSeatPositions(room);
    const sides = seats.slice(2);
    expect(sides.length).toBeGreaterThanOrEqual(4);
    expect(sides.some(s => s.z < room.cz)).toBe(true);
    expect(sides.some(s => s.z > room.cz)).toBe(true);
  });

  it("seats at least three people even in a tiny room", () => {
    expect(getMeetingSeatPositions({ cx: 0, cz: 0, w: 2, d: 2 }).length).toBeGreaterThanOrEqual(6);
  });
});

describe("sameOffice", () => {
  const agents = [
    { id: "a", flow_id: "office-1" },
    { id: "b", flow_id: "office-1" },
    { id: "c", flow_id: "office-2" },
    { id: "loose" },
  ];

  it("is true only for two agents in the same office", () => {
    expect(sameOffice(agents, "a", "b")).toBe(true);
    expect(sameOffice(agents, "a", "c")).toBe(false);
  });

  it("is false when either agent has no office or does not exist", () => {
    expect(sameOffice(agents, "a", "loose")).toBe(false);
    expect(sameOffice(agents, "a", "ghost")).toBe(false);
  });
});

describe("pickFreeChair", () => {
  const seats = [
    { x: 0, y: 0, z: 0 },
    { x: 5, y: 0, z: 0 },
  ];
  const walkerAt = (x: number, z: number, targetId = "myoffice") => ({
    targetId,
    curve: [{ x: 99, z: 99 }, { x, z }],
  });

  it("returns null when the office has no chairs", () => {
    expect(pickFreeChair([], [])).toBeNull();
  });

  it("takes the first chair when nobody is seated", () => {
    expect(pickFreeChair(seats, [])).toEqual(seats[0]);
  });

  it("skips a chair another walker is heading for", () => {
    expect(pickFreeChair(seats, [walkerAt(0, 0)])).toEqual(seats[1]);
  });

  it("ignores walkers that are not going to a seat", () => {
    expect(pickFreeChair(seats, [walkerAt(0, 0, "desk")])).toEqual(seats[0]);
  });

  it("falls back to round-robin once every chair is taken", () => {
    const full = [walkerAt(0, 0), walkerAt(5, 0)];
    expect(pickFreeChair(seats, full)).toEqual(seats[0]);
  });
});
