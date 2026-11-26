// Pin the time zone so date-dependent assertions do not vary with the host.
// Runs in the main process before workers fork, so they inherit it.
export default function setup() {
  process.env.TZ = 'UTC'
}
