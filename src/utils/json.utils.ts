export function robustJsonParse<T>(
  jsonString: string, 
  contextMessage: string = 'throwing original error',
  fallbackTemplate?: Record<string, any>
): T {
  let cleanJson = jsonString.trim();
  
  // 0. Inject missing colons between string keys and string values (e.g. "key""value" -> "key":"value")
  // Only insert the colon if we match a likely key (alphanumeric/hyphen) followed by quotes, handling smart quotes.
  cleanJson = cleanJson.replace(/([”“"'][\w-]+[”“"'])\s*([”“"'])/g, '$1:$2');

  // 0.1 Safely convert structural smart quotes to regular ASCII double quotes
  // This allows proper parsing of keys/values that start/end with smart quotes,
  // without accidentally unescaping double quotes *inside* string text.
  cleanJson = cleanJson.replace(/([\{\[\:,]\s*)[“”]/g, '$1"');
  cleanJson = cleanJson.replace(/[“”](\s*[\}\]\:,])/g, '"$1');

  // 0.2 Any remaining smart quotes are inside string boundaries. Replace with safe single quotes.
  cleanJson = cleanJson.replace(/[“”]/g, "'");

  // 1. Strip Markdown code blocks (tolerates missing closing backticks)
  const jsonMatch = cleanJson.match(/```(?:json)?\n?([\s\S]*?)(?:```|$)/i);
  if (jsonMatch && jsonMatch[1].trim().startsWith('{')) {
    cleanJson = jsonMatch[1].trim();
  }

  // 2. Strip any leading conversational text or trailing garbage via fast substring
  if (cleanJson.includes('{') && cleanJson.includes('}')) {
    const firstIdx = cleanJson.indexOf('{');
    const lastIdx = cleanJson.lastIndexOf('}');
    if (firstIdx !== -1 && lastIdx !== -1 && lastIdx > firstIdx) {
      cleanJson = cleanJson.substring(firstIdx, lastIdx + 1);
    }
  }

  // 3. Fix common Edge LLM hallucinations of wrapping the JSON end with parenthesis like `})}` or `}})`
  cleanJson = cleanJson.replace(/}\s*\)\s*}/g, '}}');
  cleanJson = cleanJson.replace(/\)\s*}/g, '}');

  // 4. Preprocess: escape unescaped newlines and control characters within string values
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

    // FINAL FALLBACK: Regex extraction of requested fields if fallbackTemplate is provided
    if (fallbackTemplate) {
      console.warn(`[robustJsonParse] Regex fallback using template for: ${contextMessage}`);
      const extractedObj: any = { ...fallbackTemplate };
      let extractedAny = false;
      
      for (const key of Object.keys(fallbackTemplate)) {
        // 1. Try to extract string values handling escaped characters like \" and \n
        const stringMatch = cleanJson.match(new RegExp(`"${key}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`));
        if (stringMatch) {
          try {
            extractedObj[key] = JSON.parse(`"${stringMatch[1]}"`);
          } catch (err) {
            extractedObj[key] = stringMatch[1];
          }
          extractedAny = true;
          continue;
        }
        
        // 2. Try to extract booleans, numbers, or null
        const primitiveMatch = cleanJson.match(new RegExp(`"${key}"\\s*:\\s*([a-zA-Z0-9_.-]+)`));
        if (primitiveMatch) {
          const val = primitiveMatch[1];
          if (val === 'true') { extractedObj[key] = true; extractedAny = true; }
          else if (val === 'false') { extractedObj[key] = false; extractedAny = true; }
          else if (val === 'null') { extractedObj[key] = null; extractedAny = true; }
          else if (!isNaN(Number(val))) { extractedObj[key] = Number(val); extractedAny = true; }
        }
      }

      if (extractedAny) {
        return extractedObj as T;
      }
    }

    console.warn(`Failed to parse Dispatcher Intent: ${contextMessage}. Falling back to plain text.`);
    throw e;
  }
  return parsed as T;
}
