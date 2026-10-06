import { robustJsonParse, decodeLiteralEscapes } from './json.utils.js';

const assert = {
  equal: (a: any, b: any) => {
    if (a !== b) throw new Error(`Assertion failed: ${a} !== ${b}`);
  },
  ok: (condition: any) => {
    if (!condition) throw new Error(`Assertion failed: expected truthy value`);
  }
};

function runTests() {
  let passed = 0;
  let failed = 0;

  const tests = [
    {
      name: 'robustJsonParse - valid JSON',
      run: () => {
        const json = '{"key":"value"}';
        const result = robustJsonParse<{ key: string }>(json);
        assert.equal(result.key, 'value');
      }
    },
    {
      name: 'robustJsonParse - markdown wrapped json',
      run: () => {
        const json = '```json\n{"key": "markdown"}\n```';
        const result = robustJsonParse<{ key: string }>(json);
        assert.equal(result.key, 'markdown');
      }
    },
    {
      name: 'robustJsonParse - trailing comma',
      run: () => {
        const json = '{"key": "trailing",}';
        const result = robustJsonParse<{ key: string }>(json);
        assert.equal(result.key, 'trailing');
      }
    },
    {
      name: 'robustJsonParse - unescaped newlines in string',
      run: () => {
        const json = `{"textResponse": "Line 1\n\nLine 2", "other": "value"}`;
        const result = robustJsonParse<{ textResponse: string; other: string }>(json);
        assert.equal(result.textResponse, 'Line 1\n\nLine 2');
        assert.equal(result.other, 'value');
      }
    },
    {
      name: 'robustJsonParse - unescaped newlines with escaped characters',
      run: () => {
        const json = `{"textResponse": "Line 1 \\"quote\\" \nLine 2"}`;
        const result = robustJsonParse<{ textResponse: string }>(json);
        assert.equal(result.textResponse, 'Line 1 "quote" \nLine 2');
      }
    },
    {
      name: 'robustJsonParse - invalid JSON syntax fallback',
      run: () => {
        const json = '{"key": "value"'; // Missing closing brace
        const result = robustJsonParse<{ key: string }>(json);
        assert.equal(result.key, 'value');
      }
    },
    {
      name: 'robustJsonParse - user specific payload case',
      run: () => {
        const json = `{"textResponse": "……\n\n（脚步顿住）", "stateUpdate": {"userNickname": "Yeoman"}}`;
        const result = robustJsonParse<{ textResponse: string }>(json);
        assert.ok(result.textResponse.includes('脚步顿住'));
      }
    },
    {
      name: 'robustJsonParse - markdown without closing backticks',
      run: () => {
        const json = '```json\n{"key": "val"}';
        const result = robustJsonParse<{ key: string }>(json);
        assert.equal(result.key, 'val');
      }
    },
    {
      name: 'robustJsonParse - leading conversational text',
      run: () => {
        const json = 'Here is the JSON you requested:\n{"key": "val"}';
        const result = robustJsonParse<{ key: string }>(json);
        assert.equal(result.key, 'val');
      }
    },
    {
      name: 'robustJsonParse - trailing garbage text',
      run: () => {
        const json = '{"key": "val"}\nHope this helps!';
        const result = robustJsonParse<{ key: string }>(json);
        assert.equal(result.key, 'val');
      }
    },
    {
      name: 'robustJsonParse - complex truncation (missing array and obj closures)',
      run: () => {
        const json = '{"status": "ok", "data": [{"id": 1';
        const result = robustJsonParse<{ status: string; data: any[] }>(json);
        assert.equal(result.status, 'ok');
        assert.equal(result.data[0].id, 1);
      }
    },
    {
      name: 'robustJsonParse - complex truncation (missing multiple obj closures)',
      run: () => {
        const json = '{"stateUpdate": {"user": {"nickname": "John"';
        const result = robustJsonParse<{ stateUpdate: { user: { nickname: string } } }>(json);
        assert.equal(result.stateUpdate.user.nickname, 'John');
      }
    },
    {
      name: 'robustJsonParse - control characters (tab and CR) inside strings',
      run: () => {
        const json = `{"text": "Tab\t and \rReturn"}`;
        const result = robustJsonParse<{ text: string }>(json);
        assert.equal(result.text, 'Tab\t and \rReturn');
      }
    },
    {
      name: 'robustJsonParse - user sample with smart quotes and missing colon',
      run: () => {
        const json = `{“textResponse":"就这点。",“actionText”“（掰下一小块递过去）”,“stateUpdate”:{“temperatureDelta”:0},“userAnalysis”:{“newFactsLearned”:[]},“triggerEvent”:null,"imageParams":null,"voiceArgs":{"emotion":"calm"}}`;
        const result = robustJsonParse<any>(json);
        assert.equal(result.actionText, '（掰下一小块递过去）');
        assert.equal(result.stateUpdate.temperatureDelta, 0);
      }
    },
    {
      name: 'robustJsonParse - empty strings without missing colons bug',
      run: () => {
        const json = `{"textResponse":"不早了 都快十一点了\\n你又在熬夜？","actionText":"","stateUpdate":{"temperatureDelta":0,"userNickname":"Yeoman","agentNickname":"Daisy","talkingStyle":"简短冷淡"},"userAnalysis":{"newFactsLearned":[]},"triggerEvent":null,"imageParams":null,"voiceArgs":null}`;
        const result = robustJsonParse<any>(json);
        assert.equal(result.textResponse, '不早了 都快十一点了\n你又在熬夜？');
        assert.equal(result.actionText, '');
        assert.equal(result.stateUpdate.talkingStyle, '简短冷淡');
      }
    },
    {
      name: 'robustJsonParse - keys with hyphens and numbers missing colons',
      run: () => {
        const json = `{"my-key-1" "val1", "key_2" "val2", "empty" ""}`;
        const result = robustJsonParse<any>(json);
        assert.equal(result['my-key-1'], 'val1');
        assert.equal(result['key_2'], 'val2');
        assert.equal(result['empty'], '');
      }
    },
    {
      name: 'robustJsonParse - edge LLM trailing parenthesis hallucination',
      run: () => {
        const json = `{"key":"value"})}`;
        const result = robustJsonParse<any>(json);
        assert.equal(result.key, 'value');
      }
    },
    {
      name: 'robustJsonParse - edge LLM trailing parenthesis hallucination with spacing',
      run: () => {
        const json = `{"key":"value"}  )  }`;
        const result = robustJsonParse<any>(json);
        assert.equal(result.key, 'value');
      }
    },
    {
      name: 'robustJsonParse - unescaped content quotes inside string values (prod incident 2026-10-06)',
      run: () => {
        // Model quoted the user's message inside actionText with raw ASCII
        // double quotes → JSON.parse fails at that quote. The repair pass
        // must escape content quotes (non-structural neighbors) and recover
        // the FULL intent — not just salvage text fields.
        const json = `{
  "textResponse": "哼，谁让你昨天一直念我小气…这张凑合给你吧",
  "actionText": "（盘腿坐在床边，看到那句"等了一晚上也没看到你的照片"，鼻子里先轻轻哼出一声。）",
  "imageParams": { "mode": "structured", "expression": "sleepy" },
  "userAnalysis": { "newFactsLearned": [{ "category": "preference", "value": "想看照片", "subject": "user", "evidence": "等了一晚上也没看到你的照片" }] },
  "stateUpdate": { "temperatureDelta": 1 }
}`;
        const result = robustJsonParse<any>(json, 'incident repro');
        assert.ok(result.textResponse.includes('凑合给你'));
        assert.ok(result.actionText.includes('"等了一晚上也没看到你的照片"'));
        assert.equal(result.imageParams.expression, 'sleepy');
        assert.equal(result.userAnalysis.newFactsLearned[0].subject, 'user');
        assert.equal(result.stateUpdate.temperatureDelta, 1);
      }
    },
    {
      name: 'robustJsonParse - repair does NOT touch already-valid JSON with escaped quotes',
      run: () => {
        const json = '{"textResponse":"他说\\"晚安\\"然后睡了","n":1}';
        const result = robustJsonParse<any>(json);
        assert.equal(result.textResponse, '他说"晚安"然后睡了');
        assert.equal(result.n, 1);
      }
    },
    {
      name: 'robustJsonParse - fullwidth quotes inside values still parse (normalized to single quotes)',
      run: () => {
        const json = '{"actionText":"（看到那句“等了一晚上”，轻轻哼了一声。）"}';
        const result = robustJsonParse<any>(json);
        // Long-standing step-0.2 normalization: interior smart quotes → '
        assert.ok(result.actionText.includes('等了一晚上'));
        assert.ok(!result.actionText.includes('"'));
      }
    },
    {
      name: 'decodeLiteralEscapes - literal \\n becomes a real newline (prod ask 2026-10-06)',
      run: () => {
        // LLMs sometimes double-escape: parsed value holds the two-char
        // text "\n" which apps render literally. Downstream text fields
        // are decoded so real line breaks render.
        assert.equal(decodeLiteralEscapes('第一行\\n第二行'), '第一行\n第二行');
        assert.equal(decodeLiteralEscapes('a\\r\\nb'), 'a\nb');
        assert.equal(decodeLiteralEscapes('no escapes'), 'no escapes');
      }
    }  ];

  for (const t of tests) {
    try {
      t.run();
      console.log(`✅ ${t.name}`);
      passed++;
    } catch (e: any) {
      console.error(`❌ ${t.name}`);
      console.error(e.message || e);
      failed++;
    }
  }

  console.log(`\nTests completed: ${passed} passed, ${failed} failed.`);
  if (failed > 0) {
    throw new Error('Tests failed');
  }
}

runTests();
