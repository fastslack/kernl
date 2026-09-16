/**
 * The kernel's logger, reached through the host.
 *
 * A copy of the logger bundled into an extension would keep its own level and
 * ignore the one the kernel was configured with. Resolving on every call means
 * a module-level `log` works even when its module is evaluated before the host
 * is installed.
 */

import { getHost, type Logger } from "./host.js";

export const log: Logger = {
  debug: (msg, data) => getHost().log.debug(msg, data),
  info: (msg, data) => getHost().log.info(msg, data),
  warn: (msg, data) => getHost().log.warn(msg, data),
  error: (msg, data) => getHost().log.error(msg, data),
};
