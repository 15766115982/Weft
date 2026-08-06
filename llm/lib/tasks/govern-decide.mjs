// govern-decide — make a governance decision using precedent few-shot context.
import { runJsonPrompt } from '../runner.mjs';
import { decisionsByType } from '../decisions.mjs';

export async function run({ kbRoot, input }) {
  const decisionType = input?.decision_type || 'approve';
  const context = input?.context || '';
  const precedents = decisionsByType(kbRoot, decisionType);
  const precedentText = precedents.length
    ? precedents.slice(-5).map((d) =>
        `- id: ${d.id}\n  decision: ${d.decision}\n  reason: ${d.reason || '(no reason)'}`
      ).join('\n')
    : '(no precedents)';

  const { data } = await runJsonPrompt(kbRoot, 'govern-decide', {
    decision_type: decisionType,
    context,
    precedents: precedentText,
  });

  const decision = ['approved', 'rejected', 'candidate'].includes(data.decision) ? data.decision : 'candidate';
  return {
    task: 'govern-decide',
    decision_type: decisionType,
    decision,
    reason: data.reason || '',
    referenced_decisions: Array.isArray(data.referenced_decisions) ? data.referenced_decisions : [],
  };
}
