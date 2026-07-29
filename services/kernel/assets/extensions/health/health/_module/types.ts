export type MetricType = "weight" | "blood_pressure" | "heart_rate" | "temperature" | "blood_sugar" | "sleep_hours" | "steps" | "oxygen" | "custom";
export type MedicationFrequency = "as_needed" | "daily" | "twice_daily" | "weekly" | "monthly";
export type AppointmentStatus = "scheduled" | "completed" | "cancelled";

export interface HealthMetric {
  id: string;
  type: MetricType;
  value: string; // string to support "120/80" for blood pressure
  unit: string;
  date: string;
  notes: string;
  created_at: string;
}

export interface HealthMedication {
  id: string;
  name: string;
  dosage: string;
  frequency: MedicationFrequency;
  start_date: string;
  end_date: string | null;
  active: number; // 0 | 1
  notes: string;
  created_at: string;
  updated_at: string;
}

export interface HealthAppointment {
  id: string;
  title: string;
  provider: string;
  location: string;
  date: string;
  status: AppointmentStatus;
  notes: string;
  created_at: string;
  updated_at: string;
}
