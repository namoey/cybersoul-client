export function robustJsonParse<T>(jsonString: string, contextMessage: string = 'throwing original error'): T {
  let cleanJson = jsonString.trim();
  
  // 1. Strip Markdown code blocks (tolerates missing closing backticks)
  const jsonMatch = cleanJson.match(/```(?:json)?\n?([\s\S]*?)(?:```|$)/i);
  if (jsonMatch && jsonMatch[1].trim().startsWith('{')) {
    cleanJson = jsonMatch[1].trim();
  }

  // 2. Strip any leading conversational text via fast substring
  if (!cleanJson.startsWith('{') && cleanJson.includes('{')) {
    const firstIdx = cleanJson.indexOf('{');
    const lastIdx = cleanJson.lastIndexOf('}');
    if (firstIdx !== -1 && lastIdx > firstIdx) {
      cleanJson = cleanJson.substring(firstIdx, lastIdx + 1);
    }
  }

  // 3. Preprocess: escape unescaped newlines and control characters within string values
  function preprocessControlChars(str: string): string {
    let result = '';
    let inString = false;
    let isEscape = false;
    for (let i = 0; i < str.length; i++) {
      const char = str[i];
      if (char === '"' && !isEscape) {
        inString = !inString;
      }
      if (char === '\\' && !isEscape) {
        isEscape = true;
      } else {
        isEscape = false;
      }
      
      if (inString) {
        if (char === '\n') {
          result += '\\n';
          continue;
        } else if (char === '\r') {
          result += '\\r';
          continue;
        } else if (char === '\t') {
          result += '\\t';
          continue;
        }
      }
      result += char;
    }
    return result;
  }

  cleanJson = preprocessControlChars(cleanJson);

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
      // Basic fallback: retry by appending missing closures for truncated LLM sequences
      const suffixes = ['}', '}}', '}}}', ']}', '}]}', '"}}', '"}}}', '"]}', '"]}}'];
      for (const suffix of suffixes) {
        try {
          parsed = JSON.parse(cleanJson + suffix);
          return parsed as T;
        } catch (err) {
          // ignore and let fallback chain continue
        }
      }

      // Last resort: Brace extraction on raw string
      const extracted = extractFirstJsonObject(cleanJson);
      if (extracted && extracted !== cleanJson && extracted.length > 0) {
        try {
          parsed = JSON.parse(extracted);
          return parsed as T;
        } catch (innerE) {
          // completely failed
        }
      }
    }
    console.warn(`Failed to parse Dispatcher Intent: ${contextMessage}. Falling back to plain text.`);
    throw e;
  }
  return parsed as T;
}
