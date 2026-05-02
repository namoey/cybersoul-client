import { robustJsonParse } from './json.utils.js';

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
