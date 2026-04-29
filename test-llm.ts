import { CyberSoulClient } from './src/client';
const config = {
  backendUrl: 'http://localhost:3100',
  characterKey: 'dummy',
  llmConfig: {
    provider: 'minimax' as const,
    apiKey: process.env.MINIMAX_API_KEY || 'dummy',
    groupId: process.env.MINIMAX_GROUP_ID || 'dummy'
  }
};
const client = new CyberSoulClient(config);

const systemPrompt = `You MUST output ONLY a valid JSON object matching this exact structure:
{
  "acceptEvent": true,
  "reason": "string (Why you accepted or declined, speaking in character)",
  "eventTitle": "string (A short title detailing exactly WHAT to do and WITH WHOM, e.g. 'Coffee with 哥哥')",
  "eventDescription": "string (Detailed description of the future event, virtual scene, and story with the participant)",
  "requiresOutfitChange": false,
  "selectedOutfitId": null,
  "scheduledStartTimeStr": "HH:MM (Optional, 24-hour format if a specific time today is agreed upon, e.g., '14:30', otherwise null)"
}
CRITICAL: Output MUST be ONLY valid JSON.`;

async function test() {
  (client as any).llm.generate = async (msgs: any) => { console.log(JSON.stringify(msgs, null, 2)); return '{ "acceptEvent": true, "eventTitle": "Test", "scheduledStartTimeStr": "14:30" }' };
  
  // mock apiFetch
  (client as any).apiFetch = async (url: string, opts: any) => {
     if (url.includes("/state")) return { ok: true, json: async () => ({ data: {} }) };
     if (url.includes("/ondemand-event")) {
         console.log("payload to backend:", opts.body);
         return { ok: true };
     }
  };

  await client.ondemandEvent({ eventDescription: "Two o'clock walk", durationMins: 30 });
}

test();
