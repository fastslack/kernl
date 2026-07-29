import type { SqliteDb } from "../../../../../src/core/db/sqlite.js";
import type {
  TravelTrip, TravelFlight, TravelAccommodation, TravelActivity,
  TravelExpense, TravelPackingItem, TravelDocument,
  TripStatus, TripPurpose, FlightStatus, AccomType, ActivityType, ExpenseCategory, DocumentType,
} from "./types.js";
import { newId, isoNow } from "../../../../../src/core/helpers.js";

export class TravelService {
  constructor(private db: SqliteDb) {}

  // ── Trips ─────────────────────────────────────────────────────────────────

  createTrip(input: {
    title: string; destination: string; start_date: string; end_date: string;
    country_code?: string; purpose?: TripPurpose; budget_cents?: number;
    currency?: string; notes?: string;
  }): TravelTrip {
    const now = isoNow();
    const trip: TravelTrip = {
      id: newId(), title: input.title, destination: input.destination,
      country_code: input.country_code ?? "", start_date: input.start_date,
      end_date: input.end_date, status: "planning",
      purpose: input.purpose ?? "leisure",
      budget_cents: input.budget_cents ?? 0,
      currency: input.currency ?? "EUR",
      notes: input.notes ?? "",
      created_at: now, updated_at: now,
    };
    this.db.prepare(`
      INSERT INTO travel_trips (id,title,destination,country_code,start_date,end_date,status,purpose,budget_cents,currency,notes,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(
      trip.id,trip.title,trip.destination,trip.country_code,trip.start_date,trip.end_date,
      trip.status,trip.purpose,trip.budget_cents,trip.currency,trip.notes,trip.created_at,trip.updated_at,
    );
    return trip;
  }

  updateTrip(id: string, changes: Partial<Pick<TravelTrip,
    "title" | "destination" | "status" | "budget_cents" | "notes" | "start_date" | "end_date"
  >>): TravelTrip | undefined {
    const existing = this.db.prepare("SELECT * FROM travel_trips WHERE id = ?").get(id) as TravelTrip | undefined;
    if (!existing) return undefined;
    const updated = { ...existing, ...changes, updated_at: isoNow() };
    this.db.prepare(`
      UPDATE travel_trips SET title=?,destination=?,status=?,budget_cents=?,notes=?,start_date=?,end_date=?,updated_at=? WHERE id=?
    `).run(updated.title,updated.destination,updated.status,updated.budget_cents,updated.notes,
           updated.start_date,updated.end_date,updated.updated_at,id);
    return updated;
  }

  listTrips(filters?: { status?: TripStatus; upcoming?: boolean }): TravelTrip[] {
    let sql = "SELECT * FROM travel_trips WHERE 1=1";
    const params: unknown[] = [];
    if (filters?.status) { sql += " AND status = ?"; params.push(filters.status); }
    if (filters?.upcoming) {
      sql += " AND end_date >= ?";
      params.push(new Date().toISOString().split("T")[0]);
    }
    sql += " ORDER BY start_date ASC";
    return this.db.prepare(sql).all(...params) as TravelTrip[];
  }

  getTrip(id: string): TravelTrip | undefined {
    return this.db.prepare("SELECT * FROM travel_trips WHERE id = ?").get(id) as TravelTrip | undefined;
  }

  // ── Flights ───────────────────────────────────────────────────────────────

  addFlight(input: {
    trip_id: string; airline?: string; flight_number?: string;
    origin: string; destination: string; departs_at: string; arrives_at: string;
    terminal?: string; gate?: string; seat?: string; booking_ref?: string;
    price_cents?: number; currency?: string; notes?: string;
  }): TravelFlight {
    const flight: TravelFlight = {
      id: newId(), trip_id: input.trip_id,
      airline: input.airline ?? "", flight_number: input.flight_number ?? "",
      origin: input.origin, destination: input.destination,
      departs_at: input.departs_at, arrives_at: input.arrives_at,
      terminal: input.terminal ?? "", gate: input.gate ?? "",
      seat: input.seat ?? "", booking_ref: input.booking_ref ?? "",
      price_cents: input.price_cents ?? 0, currency: input.currency ?? "EUR",
      status: "booked", notes: input.notes ?? "", created_at: isoNow(),
    };
    this.db.prepare(`
      INSERT INTO travel_flights (id,trip_id,airline,flight_number,origin,destination,departs_at,arrives_at,terminal,gate,seat,booking_ref,price_cents,currency,status,notes,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(
      flight.id,flight.trip_id,flight.airline,flight.flight_number,flight.origin,flight.destination,
      flight.departs_at,flight.arrives_at,flight.terminal,flight.gate,flight.seat,flight.booking_ref,
      flight.price_cents,flight.currency,flight.status,flight.notes,flight.created_at,
    );
    return flight;
  }

  updateFlight(id: string, changes: Partial<Pick<TravelFlight, "status" | "terminal" | "gate" | "seat" | "notes">>): TravelFlight | undefined {
    const existing = this.db.prepare("SELECT * FROM travel_flights WHERE id = ?").get(id) as TravelFlight | undefined;
    if (!existing) return undefined;
    const updated = { ...existing, ...changes };
    this.db.prepare(`UPDATE travel_flights SET status=?,terminal=?,gate=?,seat=?,notes=? WHERE id=?`)
      .run(updated.status,updated.terminal,updated.gate,updated.seat,updated.notes,id);
    return updated;
  }

  listFlights(tripId: string): TravelFlight[] {
    return this.db.prepare("SELECT * FROM travel_flights WHERE trip_id = ? ORDER BY departs_at ASC").all(tripId) as TravelFlight[];
  }

  // ── Accommodations ────────────────────────────────────────────────────────

  addAccommodation(input: {
    trip_id: string; name: string; type?: AccomType;
    address?: string; check_in: string; check_out: string;
    confirmation?: string; price_cents?: number; currency?: string;
    url?: string; notes?: string;
  }): TravelAccommodation {
    const accom: TravelAccommodation = {
      id: newId(), trip_id: input.trip_id, name: input.name,
      type: input.type ?? "hotel", address: input.address ?? "",
      check_in: input.check_in, check_out: input.check_out,
      confirmation: input.confirmation ?? "",
      price_cents: input.price_cents ?? 0, currency: input.currency ?? "EUR",
      url: input.url ?? "", notes: input.notes ?? "", created_at: isoNow(),
    };
    this.db.prepare(`
      INSERT INTO travel_accommodations (id,trip_id,name,type,address,check_in,check_out,confirmation,price_cents,currency,url,notes,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(
      accom.id,accom.trip_id,accom.name,accom.type,accom.address,accom.check_in,accom.check_out,
      accom.confirmation,accom.price_cents,accom.currency,accom.url,accom.notes,accom.created_at,
    );
    return accom;
  }

  listAccommodations(tripId: string): TravelAccommodation[] {
    return this.db.prepare("SELECT * FROM travel_accommodations WHERE trip_id = ? ORDER BY check_in ASC").all(tripId) as TravelAccommodation[];
  }

  // ── Activities ────────────────────────────────────────────────────────────

  addActivity(input: {
    trip_id: string; title: string; type?: ActivityType;
    date: string; start_time?: string; end_time?: string;
    location?: string; address?: string; booking_ref?: string;
    price_cents?: number; currency?: string; notes?: string;
  }): TravelActivity {
    const activity: TravelActivity = {
      id: newId(), trip_id: input.trip_id, title: input.title,
      type: input.type ?? "attraction", date: input.date,
      start_time: input.start_time ?? "", end_time: input.end_time ?? "",
      location: input.location ?? "", address: input.address ?? "",
      booking_ref: input.booking_ref ?? "",
      price_cents: input.price_cents ?? 0, currency: input.currency ?? "EUR",
      status: "planned", notes: input.notes ?? "", created_at: isoNow(),
    };
    this.db.prepare(`
      INSERT INTO travel_activities (id,trip_id,title,type,date,start_time,end_time,location,address,booking_ref,price_cents,currency,status,notes,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(
      activity.id,activity.trip_id,activity.title,activity.type,activity.date,
      activity.start_time,activity.end_time,activity.location,activity.address,
      activity.booking_ref,activity.price_cents,activity.currency,
      activity.status,activity.notes,activity.created_at,
    );
    return activity;
  }

  listActivities(tripId: string, date?: string): TravelActivity[] {
    let sql = "SELECT * FROM travel_activities WHERE trip_id = ?";
    const params: unknown[] = [tripId];
    if (date) { sql += " AND date = ?"; params.push(date); }
    sql += " ORDER BY date ASC, start_time ASC";
    return this.db.prepare(sql).all(...params) as TravelActivity[];
  }

  updateActivity(id: string, changes: Partial<Pick<TravelActivity, "status" | "notes" | "start_time" | "end_time">>): TravelActivity | undefined {
    const existing = this.db.prepare("SELECT * FROM travel_activities WHERE id = ?").get(id) as TravelActivity | undefined;
    if (!existing) return undefined;
    const updated = { ...existing, ...changes };
    this.db.prepare("UPDATE travel_activities SET status=?,notes=?,start_time=?,end_time=? WHERE id=?")
      .run(updated.status,updated.notes,updated.start_time,updated.end_time,id);
    return updated;
  }

  // ── Expenses ──────────────────────────────────────────────────────────────

  addExpense(input: {
    trip_id: string; description: string; amount_cents: number;
    category?: ExpenseCategory; currency?: string; date?: string;
    payment_method?: string; notes?: string;
  }): TravelExpense {
    const expense: TravelExpense = {
      id: newId(), trip_id: input.trip_id, category: input.category ?? "other",
      description: input.description, amount_cents: input.amount_cents,
      currency: input.currency ?? "EUR",
      date: input.date ?? isoNow().split("T")[0],
      payment_method: input.payment_method ?? "",
      receipt_url: "", notes: input.notes ?? "", created_at: isoNow(),
    };
    this.db.prepare(`
      INSERT INTO travel_expenses (id,trip_id,category,description,amount_cents,currency,date,payment_method,receipt_url,notes,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)
    `).run(
      expense.id,expense.trip_id,expense.category,expense.description,expense.amount_cents,
      expense.currency,expense.date,expense.payment_method,expense.receipt_url,
      expense.notes,expense.created_at,
    );
    return expense;
  }

  listExpenses(tripId: string): TravelExpense[] {
    return this.db.prepare("SELECT * FROM travel_expenses WHERE trip_id = ? ORDER BY date ASC").all(tripId) as TravelExpense[];
  }

  getTripBudgetSummary(tripId: string): {
    budget_cents: number; total_spent_cents: number; remaining_cents: number;
    by_category: Record<string, number>;
  } {
    const trip = this.getTrip(tripId);
    const expenses = this.listExpenses(tripId);
    const by_category: Record<string, number> = {};
    let total_spent_cents = 0;
    for (const e of expenses) {
      by_category[e.category] = (by_category[e.category] ?? 0) + e.amount_cents;
      total_spent_cents += e.amount_cents;
    }
    const budget_cents = trip?.budget_cents ?? 0;
    return { budget_cents, total_spent_cents, remaining_cents: budget_cents - total_spent_cents, by_category };
  }

  // ── Packing ───────────────────────────────────────────────────────────────

  addPackingItem(input: {
    trip_id: string; name: string; category?: string; quantity?: number; notes?: string;
  }): TravelPackingItem {
    const item: TravelPackingItem = {
      id: newId(), trip_id: input.trip_id, category: input.category ?? "general",
      name: input.name, quantity: input.quantity ?? 1, packed: 0,
      notes: input.notes ?? "", created_at: isoNow(),
    };
    this.db.prepare(`
      INSERT INTO travel_packing_items (id,trip_id,category,name,quantity,packed,notes,created_at)
      VALUES (?,?,?,?,?,?,?,?)
    `).run(item.id,item.trip_id,item.category,item.name,item.quantity,item.packed,item.notes,item.created_at);
    return item;
  }

  togglePacked(id: string): TravelPackingItem | undefined {
    const item = this.db.prepare("SELECT * FROM travel_packing_items WHERE id = ?").get(id) as TravelPackingItem | undefined;
    if (!item) return undefined;
    const packed = item.packed ? 0 : 1;
    this.db.prepare("UPDATE travel_packing_items SET packed = ? WHERE id = ?").run(packed, id);
    return { ...item, packed };
  }

  listPackingItems(tripId: string): TravelPackingItem[] {
    return this.db.prepare(
      "SELECT * FROM travel_packing_items WHERE trip_id = ? ORDER BY category ASC, name ASC"
    ).all(tripId) as TravelPackingItem[];
  }

  // ── Documents ─────────────────────────────────────────────────────────────

  addDocument(input: {
    type?: DocumentType; title: string; number?: string;
    trip_id?: string; issued_at?: string; expires_at?: string;
    country?: string; notes?: string;
  }): TravelDocument {
    const doc: TravelDocument = {
      id: newId(), trip_id: input.trip_id ?? null,
      type: input.type ?? "other", title: input.title,
      number: input.number ?? "", issued_at: input.issued_at ?? null,
      expires_at: input.expires_at ?? null, country: input.country ?? "",
      notes: input.notes ?? "", created_at: isoNow(),
    };
    this.db.prepare(`
      INSERT INTO travel_documents (id,trip_id,type,title,number,issued_at,expires_at,country,notes,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?)
    `).run(
      doc.id,doc.trip_id,doc.type,doc.title,doc.number,doc.issued_at,doc.expires_at,
      doc.country,doc.notes,doc.created_at,
    );
    return doc;
  }

  listDocuments(tripId?: string): TravelDocument[] {
    if (tripId) {
      return this.db.prepare(
        "SELECT * FROM travel_documents WHERE trip_id = ? OR trip_id IS NULL ORDER BY expires_at ASC"
      ).all(tripId) as TravelDocument[];
    }
    return this.db.prepare("SELECT * FROM travel_documents ORDER BY expires_at ASC").all() as TravelDocument[];
  }

  getExpiringDocuments(days = 90): TravelDocument[] {
    const future = new Date();
    future.setDate(future.getDate() + days);
    return this.db.prepare(
      "SELECT * FROM travel_documents WHERE expires_at IS NOT NULL AND expires_at <= ? ORDER BY expires_at ASC"
    ).all(future.toISOString().split("T")[0]) as TravelDocument[];
  }

  // ── Full itinerary ─────────────────────────────────────────────────────────

  getItinerary(tripId: string): {
    trip: TravelTrip | undefined;
    flights: TravelFlight[];
    accommodations: TravelAccommodation[];
    activities: TravelActivity[];
    budget: { budget_cents: number; total_spent_cents: number; remaining_cents: number; by_category: Record<string, number> };
    packing: { total: number; packed: number };
  } {
    const trip = this.getTrip(tripId);
    const flights = this.listFlights(tripId);
    const accommodations = this.listAccommodations(tripId);
    const activities = this.listActivities(tripId);
    const budget = this.getTripBudgetSummary(tripId);
    const packingItems = this.listPackingItems(tripId);
    return {
      trip, flights, accommodations, activities, budget,
      packing: { total: packingItems.length, packed: packingItems.filter(i => i.packed).length },
    };
  }
}
