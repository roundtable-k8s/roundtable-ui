/** Chain fixtures: a fan-out with omitted items and a looping PR pipeline run. */
import type { Chain } from '../../lib/types'

const iso = (secondsAgo: number) => new Date(Date.now() - secondsAgo * 1000).toISOString()

export function fanOutChain(): Chain {
  return {
    name: 'doc-sweep', namespace: 'roundtable', phase: 'Running', currentStep: 'review-each',
    startTime: iso(600), completionTime: null,
    steps: [
      {
        name: 'list', knight: 'galahad', domain: 'docs', phase: 'Succeeded',
        startTime: iso(600), completionTime: iso(560), result: '["a","b"]', dependsOn: null, retryCount: 0,
      },
      {
        name: 'review-each', knight: 'lancelot', domain: 'review', phase: 'Running',
        startTime: iso(550), completionTime: null, result: null, dependsOn: ['list'], retryCount: 0, maxParallel: 2,
        fanOut: {
          total: 12, pending: 3, running: 2, succeeded: 6, failed: 1, skipped: 0,
          omittedItems: 5,
          items: [
            { index: 7, phase: 'Running', taskId: 'task-item-7', startTime: iso(65), inFlight: { pod: 'lancelot-7f9c', status: 'running', elapsedMs: 65000, heartbeatAgeMs: 4000 } },
            { index: 8, phase: 'Running', taskId: 'task-item-8', inFlight: { pod: 'lancelot-2b1d', status: 'running', elapsedMs: 30000, heartbeatAgeMs: 12000 } },
            { index: 3, phase: 'Failed', taskId: 'task-item-3', error: 'timeout after 600s', retries: 2, startTime: iso(500), completionTime: iso(300) },
            { index: 6, phase: 'Succeeded', taskId: 'task-item-6', outputBytes: 2048, startTime: iso(200), completionTime: iso(100) },
          ],
        },
      },
      {
        name: 'publish', knight: 'galahad', domain: 'docs', phase: 'Skipped',
        startTime: null, completionTime: null, result: null, dependsOn: ['review-each'], retryCount: 0,
        skipReason: 'WhenFalse', when: "steps['review-each'].failed == 0",
        skipMessage: "when evaluated to false: steps['review-each'].failed == 0",
      },
    ],
  }
}

export function prPipelineChain(): Chain {
  return {
    name: 'pr-pipeline', namespace: 'roundtable', phase: 'Running', currentStep: 'review-fix',
    startTime: iso(1800), completionTime: null,
    steps: [
      {
        name: 'implement', knight: 'rt-ui', domain: 'ui', phase: 'Succeeded',
        startTime: iso(1800), completionTime: iso(1200), result: 'PR #1', dependsOn: null, retryCount: 0,
      },
      {
        name: 'review-fix', knight: 'galahad', domain: 'review', phase: 'Running',
        startTime: iso(1200), completionTime: null, result: null, dependsOn: ['implement'], retryCount: 0,
        loop: {
          iteration: 2, maxIterations: 5, onExhausted: 'fail',
          rounds: [
            {
              iteration: 1,
              steps: [
                { name: 'review', phase: 'Succeeded', iteration: 1, taskId: 'task-r1', startTime: iso(1200), completionTime: iso(1000) },
                { name: 'fix', phase: 'Succeeded', iteration: 1, taskId: 'task-f1', startTime: iso(1000), completionTime: iso(700) },
              ],
            },
            {
              iteration: 2,
              steps: [
                { name: 'review', phase: 'Running', iteration: 2, taskId: 'task-r2', startTime: iso(95), inFlight: { pod: 'galahad-5d8e', status: 'running', elapsedMs: 95000, heartbeatAgeMs: 3000 } },
              ],
            },
          ],
        },
      },
      {
        name: 'notify', knight: 'tristan', domain: 'notify', phase: 'Pending',
        startTime: null, completionTime: null, result: null, dependsOn: ['review-fix'], retryCount: 0,
      },
    ],
  }
}
