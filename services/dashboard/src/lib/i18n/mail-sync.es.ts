import type { MailSyncKey } from "./mail-sync.en.js";

// Exactly the keys of mail-sync.en.ts: a missing or extra key is a compile error.
const es: Record<MailSyncKey, string> = {
  "mailsync.waiting.title": "Preparando esta bandeja",
  "mailsync.waiting.body": "Kernl todavía no descargó el correo de {email}. El primer chequeo arranca en menos de {poll} minutos y trae los {batch} mensajes más recientes; después, cada chequeo suma lo que vaya llegando.",
  "mailsync.connecting.title": "Conectando con el servidor de correo…",
  "mailsync.connecting.body": "Kernl está entrando a {email} para ver qué hay.",
  "mailsync.downloading.title": "Descargando tu correo",
  "mailsync.downloading.body": "{done} de {total} mensajes de {email}. Van apareciendo en la lista a medida que llegan, no hace falta recargar.",
  "mailsync.error.title": "No pudimos conectar con {email}",
  "mailsync.error.server": "El servidor respondió: {error}",
  "mailsync.error.auth_hint": "Parece que la contraseña no es correcta. Corregila en Cuentas de correo y Kernl la va a usar en el próximo chequeo.",
  "mailsync.error.retry_hint": "Kernl vuelve a intentar solo cada {poll} minutos.",
  "mailsync.error.last_ok": "Última descarga correcta: {ago}.",
  "mailsync.error.accounts_link": "Abrir Cuentas de correo",
  "mailsync.empty.title": "Todo al día",
  "mailsync.empty.body": "Kernl revisó {email} {ago} y la bandeja del servidor está vacía. Vuelve a mirar cada {poll} minutos.",
  "mailsync.gmail.title": "Esperando a Gmail",
  "mailsync.gmail.body": "Esta cuenta se sincroniza a través de Google, no del descargador de correo. Sus mensajes aparecen después de la próxima sincronización de Gmail.",
  "mailsync.summary.title": "Algunas bandejas todavía se están cargando",
  "mailsync.summary.pending": "Descargando",
  "mailsync.summary.failing": "Sin conexión",
  "mailsync.summary.ready": "{n} listas",
  "mailsync.summary.hint": "Elegí una cuenta para ver el detalle.",
  "mailbody.images_blocked": "Se bloquearon {n} imagen(es) remota(s). Cargarlas le avisa al remitente que abriste este mail, cuándo y desde dónde.",
  "mailbody.show_images": "Mostrar imágenes",
  "mailbody.view_text": "Texto plano",
  "mailbody.view_html": "Con formato",
  "mailbody.empty": "(vacío)",
};

export default es;
