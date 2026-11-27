// Pin the time zone so date-dependent assertions do not vary with the host.
// Runs in the main process before workers fork, so they inherit it.
export default function setup() {
  // Set VITEST_KEEP_TZ=1 to run the suite in the host's (or an explicit TZ=) zone.
  if (process.env.VITEST_KEEP_TZ !== '1') process.env.TZ = 'UTC'
}
