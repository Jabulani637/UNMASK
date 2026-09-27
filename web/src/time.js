/**
 * Times, the way a person reads a chat list.
 *
 * A thread list wants "4m", a message inside a conversation wants "14:32", and a
 * row from last term wants a date. One function with a `style` argument would
 * grow an argument for every call site, so there are two named ones instead.
 */

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

function date(value) {
  const when = value instanceof Date ? value : new Date(value);
  return Number.isNaN(when.getTime()) ? null : when;
}

/** For a list: how long ago, shrinking as it gets older. */
export function ago(value) {
  const when = date(value);
  if (!when) return '';

  const diff = Date.now() - when.getTime();
  if (diff < MINUTE) return 'just now';
  if (diff < 60 * MINUTE) return `${Math.floor(diff / MINUTE)}m`;

  // Anything past an hour is either the same day or not, and "18h" hiding the
  // fact that a conversation is from yesterday is not useful information.
  const today = new Date();
  const sameDay = when.toDateString() === today.toDateString();
  if (sameDay) return `${Math.floor(diff / HOUR)}h`;
  if (diff < 2 * DAY) return 'yesterday';
  if (when.getFullYear() === today.getFullYear()) {
    return when.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
  }
  return when.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

/** For a message: the clock time, plus the day once it is not today. */
export function clockTime(value) {
  const when = date(value);
  if (!when) return '';

  const time = when.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  const today = new Date();
  if (when.toDateString() === today.toDateString()) return time;
  return `${when.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}, ${time}`;
}
