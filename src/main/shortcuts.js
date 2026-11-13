// Physical codes keep application shortcuts usable with Persian and other layouts.
function shortcutAction(input) {
  if (input.type !== 'keyDown' || !(input.control || input.meta) || input.alt) return null;
  const byCode = { Comma: 'settings', KeyK: 'search', Digit1: 'all', KeyR: 'reload' };
  const byKey = { ',': 'settings', k: 'search', '1': 'all', r: 'reload' };
  return byCode[input.code] || byKey[String(input.key || '').toLowerCase()] || null;
}

module.exports = { shortcutAction };
