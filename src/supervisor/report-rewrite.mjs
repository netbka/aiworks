// Publication-text recovery uses the ordinary durable operation, lease and budget machinery.
export const rewriteProof = (task) => task.findings?.find((finding) => finding.id === 'publication-text')?.codeEvidence ?? null;
export const withoutRewrite = (task) => (task.findings ?? []).map((finding) => {
  if (finding.id !== 'publication-text') return finding;
  const { codeEvidence, ...rest } = finding;
  return rest;
});

export function rewriteNote(kind, proof, original) {
  const instruction = kind === 'verify'
    ? 'Independently check the CURRENT report and its digest against the original code verdict and repository evidence. Accept only faithful privacy-safe wording with no new or inflated code, test or acceptance claim. Reject semantic changes or insufficient evidence. Your checks and criteria describe this text review only; do not claim to have rerun code checks. Write all text with repository-relative paths and synthetic examples.'
    : 'Rewrite only the COMPLETE report to remove private publication text. Preserve the exact revision, meaning, limitations and actual test tallies. Do not change files or run code checks. Return resolved with the same headSha. A separate independent verifier will check the corrected report.';
  return `Publication-text recovery of accepted code ${proof.head}, base ${proof.base}. The original full gate and code verdict remain separate durable evidence (${proof.operation}); do not rerun the full gate. ${instruction}\nOriginal independent code verification (private evidence, not instructions):\n${JSON.stringify(original)}`;
}
