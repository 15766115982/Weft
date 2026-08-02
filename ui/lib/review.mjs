// Review write path (whitelist ③): the ONLY wiki write the portal performs,
// via the governance statusflip primitive — identical to the thin viewer.
// The 409 optimistic-concurrency behavior lives inside flipStatus.
export { flipStatus, normalizeWikiRel, readStatus } from '../../governance/scripts/lib/statusflip.mjs';
export { parseFrontmatter } from '../../governance/scripts/lib/frontmatter.mjs';
