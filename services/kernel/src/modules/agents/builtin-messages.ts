/**
 * Localised strings for the builtin (no-LLM) agents.
 *
 * These handlers used to hardcode Spanish, then half-hardcode English, in a
 * product that already carries a `language` setting — so a kernel configured
 * either way got the other. The catalogue lives in its own file so adding a
 * language, or a message, never means editing handler logic.
 *
 * Locale for dates/times is derived from the language rather than pinned to
 * `es-AR`: the same briefing renders as "09:05" for a Dutch operator and
 * "9:05 AM" for an American one, instead of always following Buenos Aires.
 */

import type { KernelLanguage } from "../../core/config.js";

/** BCP-47 tag used for `toLocaleTimeString` / `toLocaleDateString`. */
export function localeFor(language: KernelLanguage): string {
  return language === "es" ? "es-AR" : "en-US";
}

interface BuiltinMessages {
  morning: {
    greeting: string;
    tasksToday: (n: number) => string;
    tasksOverdue: (n: number) => string;
    upcomingReminders: string;
    nothingPending: string;
  };
  evening: {
    heading: string;
    completed: (n: number) => string;
    remaining: (n: number) => string;
    tomorrow: (n: number) => string;
    remindersFired: (n: number) => string;
    wellDone: string;
  };
  weekly: {
    heading: string;
    tasksCreated: (n: number) => string;
    tasksCompleted: (n: number) => string;
    remindersFired: (n: number) => string;
    contactsAdded: (n: number) => string;
    spending: (amount: string, currency: string) => string;
    completionRate: (pct: number) => string;
  };
  monitor: {
    offlineBody: string;
    allOnline: string;
    someOffline: (n: number) => string;
    skipped: string;
  };
}

const EN: BuiltinMessages = {
  morning: {
    greeting: "Good morning!\n",
    tasksToday: (n) => `${n} task${n === 1 ? "" : "s"} due today`,
    tasksOverdue: (n) => `${n} task${n === 1 ? "" : "s"} overdue`,
    upcomingReminders: "\nUpcoming reminders:",
    nothingPending: "No pending tasks or reminders. Have a good day!",
  },
  evening: {
    heading: "Daily summary\n",
    completed: (n) => `Tasks completed: ${n}`,
    remaining: (n) => `Tasks pending: ${n}`,
    tomorrow: (n) => `Due tomorrow: ${n}`,
    remindersFired: (n) => `Reminders fired: ${n}`,
    wellDone: "\nGood work today!",
  },
  weekly: {
    heading: "Weekly summary\n",
    tasksCreated: (n) => `Tasks created: ${n}`,
    tasksCompleted: (n) => `Tasks completed: ${n}`,
    remindersFired: (n) => `Reminders fired: ${n}`,
    contactsAdded: (n) => `Contacts added: ${n}`,
    spending: (amount, currency) => `Spending: ${amount} ${currency}`,
    completionRate: (pct) => `\nCompletion rate: ${pct}%`,
  },
  monitor: {
    offlineBody: "The agent has not responded in the last 10 minutes.",
    allOnline: "All external agents online.",
    someOffline: (n) => `${n} agent(s) went offline.`,
    skipped: "Agent monitor check skipped (table not available).",
  },
};

const ES: BuiltinMessages = {
  morning: {
    greeting: "¡Buenos días!\n",
    tasksToday: (n) => `${n} tarea${n === 1 ? "" : "s"} para hoy`,
    tasksOverdue: (n) => `${n} tarea${n === 1 ? "" : "s"} atrasada${n === 1 ? "" : "s"}`,
    upcomingReminders: "\nPróximos recordatorios:",
    nothingPending: "Sin tareas ni recordatorios pendientes. ¡Buen día!",
  },
  evening: {
    heading: "Resumen del día\n",
    completed: (n) => `Tareas completadas: ${n}`,
    remaining: (n) => `Tareas pendientes: ${n}`,
    tomorrow: (n) => `Para mañana: ${n}`,
    remindersFired: (n) => `Recordatorios disparados: ${n}`,
    wellDone: "\n¡Buen trabajo hoy!",
  },
  weekly: {
    heading: "Resumen semanal\n",
    tasksCreated: (n) => `Tareas creadas: ${n}`,
    tasksCompleted: (n) => `Tareas completadas: ${n}`,
    remindersFired: (n) => `Recordatorios disparados: ${n}`,
    contactsAdded: (n) => `Contactos agregados: ${n}`,
    spending: (amount, currency) => `Gastos: ${amount} ${currency}`,
    completionRate: (pct) => `\nTasa de completado: ${pct}%`,
  },
  monitor: {
    offlineBody: "El agente no respondió en los últimos 10 minutos.",
    allOnline: "Todos los agentes externos están online.",
    someOffline: (n) => `${n} agente(s) se desconectaron.`,
    skipped: "Chequeo de agentes omitido (tabla no disponible).",
  },
};

/** Message catalogue for a language. Unknown values fall back to English. */
export function messagesFor(language: KernelLanguage | undefined): BuiltinMessages {
  return language === "es" ? ES : EN;
}
