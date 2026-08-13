/**
 * Copy for /wellness, in the two locales the page ships.
 *
 * Flat keys on purpose — `createI18n` does one map lookup, no path walking.
 * The shell owns the active locale and broadcasts switches on the kernl: event
 * bus, so a page mounted in English re-renders in Spanish without a remount.
 */
import type { Dict } from "$shared/i18n";

export const en: Dict = {
  // Header
  "title": "Wellness",
  "sub": "Your health and fitness dashboard",
  "sub.date": "Showing {date}",
  "loading": "Loading your wellness overview…",

  // Quick actions
  "qa.metric": "Log Metric",
  "qa.workout": "Log Workout",
  "qa.meal": "Log Meal",
  "qa.water": "Log Water",

  // KPIs
  "kpi.weight": "Weight",
  "kpi.steps": "Steps",
  "kpi.medications": "Medications",
  "kpi.workouts": "Workouts",
  "kpi.streak": "Streak",
  "kpi.calories": "Calories",
  "kpi.sub.today": "today",
  "kpi.sub.active": "active",
  "kpi.sub.week": "this week",
  "kpi.sub.days": "days",
  "kpi.sub.days.one": "day",
  "kpi.sub.none": "not logged yet",

  // Cards
  "card.health": "Health",
  "card.training": "Training",
  "card.nutrition": "Nutrition",
  "card.view.health": "View Health",
  "card.view.training": "View Training",
  "card.view.nutrition": "View Nutrition",

  // Empty states — with data
  "empty.health.title": "No metrics yet",
  "empty.health.hint": "Track weight, blood pressure, sleep or steps and they show up here.",
  "empty.health.cta": "Log Your First Metric",
  "empty.training.title": "No workouts yet",
  "empty.training.hint": "Log a run, a ride or a session and your streak starts counting.",
  "empty.training.cta": "Log Your First Workout",
  "empty.nutrition.title": "Nothing eaten yet today",
  "empty.nutrition.hint": "Log a meal to see calories and macros for the day.",
  "empty.nutrition.cta": "Log Your First Meal",

  // Empty states — module off
  "off.health.title": "Health module is off",
  "off.health.hint": "Enable the Health extension to track metrics, medications and appointments.",
  "off.training.title": "Training module is off",
  "off.training.hint": "Enable the Training extension to log workouts and track your streak.",
  "off.nutrition.title": "Nutrition module is off",
  "off.nutrition.hint": "Enable the Nutrition extension to log meals, macros and water.",
  "off.cta": "Open Extensions",

  // Nutrition card
  "nutr.kcal": "kcal today",
  "nutr.protein": "Protein",
  "nutr.carbs": "Carbs",
  "nutr.fat": "Fat",
  "nutr.water": "Water",

  // Modal — shared
  "modal.cancel": "Cancel",
  "modal.saving": "Saving…",
  "modal.close": "Close dialog",
  "modal.required": "This field is required.",
  "modal.number": "Enter a number.",

  // Modal — metric
  "m.metric.title": "Log Metric",
  "m.metric.sub": "Track a body or vitals reading.",
  "m.metric.type": "Type",
  "m.metric.value": "Value",
  "m.metric.unit": "Unit",
  "m.metric.date": "Date",
  "m.metric.save": "Save Metric",
  "m.metric.ok": "{type} logged · {value} {unit}",

  // Metric types
  "mt.weight": "Weight",
  "mt.steps": "Steps",
  "mt.blood_pressure": "Blood Pressure",
  "mt.heart_rate": "Heart Rate",
  "mt.sleep_hours": "Sleep",
  "mt.body_fat": "Body Fat",
  "mt.glucose": "Glucose",
  "mt.temperature": "Temperature",

  // Modal — workout
  "m.workout.title": "Log Workout",
  "m.workout.sub": "Record a cardio session you already finished.",
  "m.workout.activity": "Activity",
  "m.workout.duration": "Duration (minutes)",
  "m.workout.distance": "Distance (km)",
  "m.workout.calories": "Calories burned",
  "m.workout.date": "Date",
  "m.workout.save": "Save Workout",
  "m.workout.ok": "{activity} logged · {duration} min",
  "m.workout.optional": "optional",

  // Activities
  "act.running": "Running",
  "act.cycling": "Cycling",
  "act.walking": "Walking",
  "act.swimming": "Swimming",
  "act.rowing": "Rowing",
  "act.elliptical": "Elliptical",
  "act.hiking": "Hiking",
  "act.other": "Other",

  // Modal — meal
  "m.meal.title": "Log Meal",
  "m.meal.sub": "Add what you ate to today's totals.",
  "m.meal.food": "Food",
  "m.meal.type": "Meal",
  "m.meal.qty": "Quantity (g)",
  "m.meal.calories": "Calories",
  "m.meal.protein": "Protein (g)",
  "m.meal.carbs": "Carbs (g)",
  "m.meal.fat": "Fat (g)",
  "m.meal.save": "Save Meal",
  "m.meal.ok": "{food} logged · {calories} kcal",
  "m.meal.placeholder": "Grilled chicken, oatmeal…",

  // Meal types
  "meal.breakfast": "Breakfast",
  "meal.lunch": "Lunch",
  "meal.dinner": "Dinner",
  "meal.snack": "Snack",
  "meal.other": "Other",

  // Modal — water
  "m.water.title": "Log Water",
  "m.water.sub": "Tap an amount, or enter your own.",
  "m.water.amount": "Amount",
  "m.water.custom": "Custom amount (ml)",
  "m.water.save": "Save Water",
  "m.water.ok": "{amount} ml of water logged",

  // Errors
  "err.generic": "Could not save. Check your connection and try again.",
  "err.prefix": "Could not save: {msg}",
};

export const es: Dict = {
  // Header
  "title": "Bienestar",
  "sub": "Tu panel de salud y estado físico",
  "sub.date": "Mostrando {date}",
  "loading": "Cargando tu resumen de bienestar…",

  // Quick actions
  "qa.metric": "Registrar medición",
  "qa.workout": "Registrar entreno",
  "qa.meal": "Registrar comida",
  "qa.water": "Registrar agua",

  // KPIs
  "kpi.weight": "Peso",
  "kpi.steps": "Pasos",
  "kpi.medications": "Medicamentos",
  "kpi.workouts": "Entrenos",
  "kpi.streak": "Racha",
  "kpi.calories": "Calorías",
  "kpi.sub.today": "hoy",
  "kpi.sub.active": "activos",
  "kpi.sub.week": "esta semana",
  "kpi.sub.days": "días",
  "kpi.sub.days.one": "día",
  "kpi.sub.none": "sin registrar",

  // Cards
  "card.health": "Salud",
  "card.training": "Entrenamiento",
  "card.nutrition": "Nutrición",
  "card.view.health": "Ver salud",
  "card.view.training": "Ver entrenamiento",
  "card.view.nutrition": "Ver nutrición",

  // Empty states — with data
  "empty.health.title": "Todavía no hay mediciones",
  "empty.health.hint": "Registrá peso, presión, sueño o pasos y aparecen acá.",
  "empty.health.cta": "Registrá tu primera medición",
  "empty.training.title": "Todavía no hay entrenos",
  "empty.training.hint": "Registrá una salida o una sesión y tu racha empieza a contar.",
  "empty.training.cta": "Registrá tu primer entreno",
  "empty.nutrition.title": "Hoy todavía no comiste nada registrado",
  "empty.nutrition.hint": "Registrá una comida para ver calorías y macros del día.",
  "empty.nutrition.cta": "Registrá tu primera comida",

  // Empty states — module off
  "off.health.title": "El módulo de salud está apagado",
  "off.health.hint": "Activá la extensión Salud para registrar mediciones, medicamentos y turnos.",
  "off.training.title": "El módulo de entrenamiento está apagado",
  "off.training.hint": "Activá la extensión Entrenamiento para registrar entrenos y llevar tu racha.",
  "off.nutrition.title": "El módulo de nutrición está apagado",
  "off.nutrition.hint": "Activá la extensión Nutrición para registrar comidas, macros y agua.",
  "off.cta": "Abrir extensiones",

  // Nutrition card
  "nutr.kcal": "kcal hoy",
  "nutr.protein": "Proteínas",
  "nutr.carbs": "Carbohidratos",
  "nutr.fat": "Grasas",
  "nutr.water": "Agua",

  // Modal — shared
  "modal.cancel": "Cancelar",
  "modal.saving": "Guardando…",
  "modal.close": "Cerrar diálogo",
  "modal.required": "Este campo es obligatorio.",
  "modal.number": "Ingresá un número.",

  // Modal — metric
  "m.metric.title": "Registrar medición",
  "m.metric.sub": "Anotá una medición corporal o de signos vitales.",
  "m.metric.type": "Tipo",
  "m.metric.value": "Valor",
  "m.metric.unit": "Unidad",
  "m.metric.date": "Fecha",
  "m.metric.save": "Guardar medición",
  "m.metric.ok": "{type} registrado · {value} {unit}",

  // Metric types
  "mt.weight": "Peso",
  "mt.steps": "Pasos",
  "mt.blood_pressure": "Presión arterial",
  "mt.heart_rate": "Frecuencia cardíaca",
  "mt.sleep_hours": "Sueño",
  "mt.body_fat": "Grasa corporal",
  "mt.glucose": "Glucosa",
  "mt.temperature": "Temperatura",

  // Modal — workout
  "m.workout.title": "Registrar entreno",
  "m.workout.sub": "Anotá una sesión de cardio que ya terminaste.",
  "m.workout.activity": "Actividad",
  "m.workout.duration": "Duración (minutos)",
  "m.workout.distance": "Distancia (km)",
  "m.workout.calories": "Calorías quemadas",
  "m.workout.date": "Fecha",
  "m.workout.save": "Guardar entreno",
  "m.workout.ok": "{activity} registrado · {duration} min",
  "m.workout.optional": "opcional",

  // Activities
  "act.running": "Correr",
  "act.cycling": "Ciclismo",
  "act.walking": "Caminar",
  "act.swimming": "Natación",
  "act.rowing": "Remo",
  "act.elliptical": "Elíptico",
  "act.hiking": "Senderismo",
  "act.other": "Otro",

  // Modal — meal
  "m.meal.title": "Registrar comida",
  "m.meal.sub": "Sumá lo que comiste al total de hoy.",
  "m.meal.food": "Alimento",
  "m.meal.type": "Comida",
  "m.meal.qty": "Cantidad (g)",
  "m.meal.calories": "Calorías",
  "m.meal.protein": "Proteínas (g)",
  "m.meal.carbs": "Carbohidratos (g)",
  "m.meal.fat": "Grasas (g)",
  "m.meal.save": "Guardar comida",
  "m.meal.ok": "{food} registrado · {calories} kcal",
  "m.meal.placeholder": "Pollo a la plancha, avena…",

  // Meal types
  "meal.breakfast": "Desayuno",
  "meal.lunch": "Almuerzo",
  "meal.dinner": "Cena",
  "meal.snack": "Snack",
  "meal.other": "Otro",

  // Modal — water
  "m.water.title": "Registrar agua",
  "m.water.sub": "Tocá una cantidad, o ingresá la tuya.",
  "m.water.amount": "Cantidad",
  "m.water.custom": "Cantidad personalizada (ml)",
  "m.water.save": "Guardar agua",
  "m.water.ok": "{amount} ml de agua registrados",

  // Errors
  "err.generic": "No se pudo guardar. Revisá tu conexión y probá de nuevo.",
  "err.prefix": "No se pudo guardar: {msg}",
};
