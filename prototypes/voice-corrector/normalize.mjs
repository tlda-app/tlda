const TOKEN_BOUNDARY = String.raw`[\p{L}\p{N}_]`;

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function rulePattern(rule) {
  if (rule.match === "word") {
    return new RegExp(String.raw`(?<!${TOKEN_BOUNDARY})${escapeRegExp(rule.surface)}(?!${TOKEN_BOUNDARY})`, "giu");
  }

  if (rule.match === "phrase") {
    const phrase = rule.surface
      .trim()
      .split(/\s+/)
      .map(escapeRegExp)
      .join(String.raw`\s+`);
    return new RegExp(String.raw`(?<!${TOKEN_BOUNDARY})${phrase}(?!${TOKEN_BOUNDARY})`, "giu");
  }

  throw new Error(`Unsupported vocab rule match type: ${rule.match}`);
}

export function normalize(text, vocab) {
  if (typeof text !== "string") {
    throw new TypeError("normalize(text, vocab) requires text to be a string");
  }

  const edits = [];
  let corrected = text;

  for (const rule of vocab?.rules ?? []) {
    const pattern = rulePattern(rule);
    corrected = corrected.replace(pattern, (from) => {
      edits.push({
        from,
        to: rule.to,
        rule: {
          surface: rule.surface,
          to: rule.to,
          match: rule.match
        }
      });
      return rule.to;
    });
  }

  return { corrected, edits };
}
