import { ghInvocations, apiEndpoint, apiFlag } from './gh-command.mjs'

/**
 * Merging and approving through `gh api`, which `gh pr merge` and `gh pr review` reach by another
 * road.
 *
 * **Why this is not the same question as the grep in the hook.** `gh pr merge` is identifiable from
 * its words: the noun and the verb are right there, and a text matcher anchored on command position
 * decides it. `gh api` names what it acts on in a path and how in a flag, and the same path is a
 * read or a write depending on the method — `GET /pulls/1/merge` asks whether a PR was merged and
 * merges nothing. So this half parses and the other half greps, and neither is the wrong tool for
 * the surface it covers.
 *
 * **The scope limit that remains.** GraphQL's `mergePullRequest` is not covered. It is identified by
 * the contents of a query string rather than by a path, which is the same shape as the comment
 * card's `addComment` problem and wants the same enumeration; doing it here first would mean
 * maintaining that list in two places before either has aged. The threat model is unchanged — these
 * gates guard a cooperative-but-forgetful agent, and an agent that means to bypass one always can.
 */

/** `PUT /repos/{owner}/{repo}/pulls/{n}/merge` — the API form of `gh pr merge`. */
const MERGE_PATH = /\/pulls\/[^/]+\/merge(\/|$|\?)/
/** `POST /repos/{owner}/{repo}/pulls/{n}/reviews` — the API form of `gh pr review`. */
const REVIEW_PATH = /\/pulls\/[^/]+\/reviews(\/|$|\?)/

/** Field flags. Their presence is what makes gh send POST when no method is given. */
const FIELD_FLAGS = ['-f', '-F', '--field', '--raw-field', '--input']

/**
 * @returns {{ blocked: boolean, reason?: 'merge' | 'review' }}
 *
 * **A read of the same path is allowed**, the way `--method GET` is on every other `gh api` rule
 * here. `GET /pulls/1/merge` is how you ask whether a PR is merged, and `GET …/reviews` lists them;
 * blocking those would refuse the two commands most likely to precede a legitimate question about a
 * PR. With no method given, gh sends GET unless a field is present, so that is what decides.
 */
export function judge(cmd) {
  for (const words of ghInvocations(cmd, 'api', null)) {
    const endpoint = apiEndpoint(words)
    if (!endpoint) continue
    const explicit = (apiFlag(words, '--method', '-X') ?? '').toUpperCase()
    const hasField = words.some((w) => FIELD_FLAGS.includes(w) || FIELD_FLAGS.some((f) => w.startsWith(`${f}=`)))
    const method = explicit || (hasField ? 'POST' : 'GET')
    if (method === 'GET' || method === 'HEAD') continue
    if (MERGE_PATH.test(endpoint)) return { blocked: true, reason: 'merge' }
    // Every write to `…/reviews` is refused, not only `event=APPROVE`. The sibling grep refuses
    // `gh pr review` whatever its flags, and a review left pending is still a review submitted under
    // the user's name.
    if (REVIEW_PATH.test(endpoint)) return { blocked: true, reason: 'review' }
  }
  return { blocked: false }
}
