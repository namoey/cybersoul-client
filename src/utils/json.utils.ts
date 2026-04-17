export function robustJsonParse<T>(jsonString: string, contextMessage: string = 'throwing original error'): T {
  let cleanJson = jsonString.trim();
  const jsonMatch = cleanJson.match(/```json\n?([\s\S]*?)\n?```/i) || cleanJson.match(/```\n?([\s\S]*?)\n?```/);
  if (jsonMatch) {
    cleanJson = jsonMatch[1].trim();
  }
  cleanJson = cleanJson.replace(/,(\s*[}\]])/g, '$1');
  cleanJson = cleanJson.replace(/,\s*$/, '');

  // Extract the first complete JSON object by brace counting if it looks like there's trailing garbage
  function extractFirstJsonObject(str: string): string {
    let braceCount = 0;
    let startIdx = str.indexOf('{');
    if (startIdx === -1) return str;
    
    let inString = false;
    let escape = false;

    for (let i = startIdx; i < str.length; i++) {
      const char = str[i];
      if (!escape && char === '"') {
        inString = !inString;
      }
      escape = (char === '\\' && !escape);

      if (!inString) {
        if (char === '{') braceCount++;
        else if (char === '}') {
          braceCount--;
          if (braceCount === 0) {
            return str.substring(startIdx, i + 1);
          }
        }
      }
    }
    return str;
  }

  let parsed;
  try {
    parsed = JSON.parse(cleanJson);
  } catch (e: any) {
    if (e instanceof SyntaxError) {
      const extracted = extractFirstJsonObject(cleanJson);
      if (extracted !== cleanJson) {
        try {
          parsed = JSON.parse(extracted);
          return parsed as T;
        } catch (innerE) {
          // ignore and let fallback chain continue
        }
      }
    }

    try {
      parsed = JSON.parse(cleanJson + '}');
    } catch (e2) {
      try {
        parsed = JSON.parse(cleanJson + '}}');
      } catch (e3) {
        console.warn(`Failed to parse Dispatcher Intent: ${contextMessage}. Falling back to plain text.`);
        throw e;
      }
    }
  }
  return parsed as T;
}
