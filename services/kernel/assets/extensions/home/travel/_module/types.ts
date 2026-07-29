export type TripStatus = "planning" | "booked" | "in_progress" | "completed" | "cancelled";
export type TripPurpose = "leisure" | "business" | "family" | "medical" | "other";
export type FlightStatus = "booked" | "checked_in" | "boarded" | "completed" | "cancelled";
export type AccomType = "hotel" | "airbnb" | "hostel" | "camping" | "friend" | "other";
export type ActivityType = "attraction" | "restaurant" | "transport" | "tour" | "event" | "meeting" | "other";
export type ExpenseCategory = "flight" | "accommodation" | "food" | "transport" | "activity" | "shopping" | "health" | "other";
export type DocumentType = "passport" | "visa" | "insurance" | "booking" | "ticket" | "other";

export interface TravelTrip {
  id: string;
  title: string;
  destination: string;
  country_code: string;
  start_date: string;
  end_date: string;
  status: TripStatus;
  purpose: TripPurpose;
  budget_cents: number;
  currency: string;
  notes: string;
  created_at: string;
  updated_at: string;
}

export interface TravelFlight {
  id: string;
  trip_id: string;
  airline: string;
  flight_number: string;
  origin: string;
  destination: string;
  departs_at: string;
  arrives_at: string;
  terminal: string;
  gate: string;
  seat: string;
  booking_ref: string;
  price_cents: number;
  currency: string;
  status: FlightStatus;
  notes: string;
  created_at: string;
}

export interface TravelAccommodation {
  id: string;
  trip_id: string;
  name: string;
  type: AccomType;
  address: string;
  check_in: string;
  check_out: string;
  confirmation: string;
  price_cents: number;
  currency: string;
  url: string;
  notes: string;
  created_at: string;
}

export interface TravelActivity {
  id: string;
  trip_id: string;
  title: string;
  type: ActivityType;
  date: string;
  start_time: string;
  end_time: string;
  location: string;
  address: string;
  booking_ref: string;
  price_cents: number;
  currency: string;
  status: "planned" | "booked" | "completed" | "skipped";
  notes: string;
  created_at: string;
}

export interface TravelExpense {
  id: string;
  trip_id: string;
  category: ExpenseCategory;
  description: string;
  amount_cents: number;
  currency: string;
  date: string;
  payment_method: string;
  receipt_url: string;
  notes: string;
  created_at: string;
}

export interface TravelPackingItem {
  id: string;
  trip_id: string;
  category: string;
  name: string;
  quantity: number;
  packed: number; // boolean
  notes: string;
  created_at: string;
}

export interface TravelDocument {
  id: string;
  trip_id: string | null;
  type: DocumentType;
  title: string;
  number: string;
  issued_at: string | null;
  expires_at: string | null;
  country: string;
  notes: string;
  created_at: string;
}
