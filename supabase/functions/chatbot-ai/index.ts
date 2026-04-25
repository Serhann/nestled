import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

interface ChatSettings {
  ai_enabled: boolean;
  ai_provider: 'knowledge_base' | 'openai' | 'ollama';
  openai_api_key?: string;
  openai_model?: string;
  ollama_url?: string;
  ollama_model?: string;
  system_prompt?: string;
  ai_response_mode?: 'always' | 'first_message' | 'off';
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, {
      status: 200,
      headers: corsHeaders,
    });
  }

  try {
    const { conversation_id, message, domain } = await req.json();

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseKey);

    const { data: settings } = await supabase
      .from("chat_settings")
      .select("*")
      .single();

    if (!settings || !settings.ai_enabled) {
      return new Response(
        JSON.stringify({ error: "AI is disabled" }),
        {
          status: 200,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    const aiResponseMode = settings.ai_response_mode || 'first_message';

    if (aiResponseMode === 'off') {
      return new Response(
        JSON.stringify({ error: "AI responses are turned off" }),
        {
          status: 200,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    const { data: conversation } = await supabase
      .from("conversations")
      .select("ai_greeted")
      .eq("id", conversation_id)
      .single();

    if (aiResponseMode === 'first_message' && conversation && conversation.ai_greeted) {
      return new Response(
        JSON.stringify({ error: "AI already greeted, staying silent" }),
        {
          status: 200,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    // Bilgi havuzunu filtreleme (Kategori = Domain veya General)
    const validCategories = ['general', 'General', 'genel', 'Genel', ''];
    if (domain) validCategories.push(domain.toLowerCase(), domain);

    const { data: knowledgeBase } = await supabase
      .from("knowledge_base")
      .select("*")
      .eq("is_active", true)
      .in("category", validCategories);

    let aiResponse = "";
    const provider = settings.ai_provider || 'knowledge_base';

    if (provider === 'openai' && settings.openai_api_key) {
      aiResponse = await getOpenAIResponse(
        message,
        knowledgeBase || [],
        settings
      );
    } else if (provider === 'ollama' && settings.ollama_url) {
      aiResponse = await getOllamaResponse(
        message,
        knowledgeBase || [],
        settings
      );
    } else {
      aiResponse = getKnowledgeBaseResponse(message, knowledgeBase || []);
    }

    await supabase.from("messages").insert({
      conversation_id: conversation_id,
      content: aiResponse,
      sender_type: "ai",
      sender_id: null,
    });

    if (aiResponseMode === 'first_message') {
      await supabase
        .from("conversations")
        .update({ ai_greeted: true })
        .eq("id", conversation_id);
    }

    return new Response(
      JSON.stringify({ success: true, response: aiResponse }),
      {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  } catch (error) {
    console.error("Error:", error);
    return new Response(
      JSON.stringify({ error: error.message }),
      {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  }
});

function getKnowledgeBaseResponse(message: string, knowledgeBase: any[]): string {
  if (!knowledgeBase || knowledgeBase.length === 0) {
    return "I'm here to help! Could you please provide more details about your question?";
  }

  const messageLower = message.toLowerCase();
  let bestMatch = null;
  let bestScore = 0;

  for (const item of knowledgeBase) {
    let score = 0;

    const questionLower = item.question.toLowerCase();
    if (questionLower.includes(messageLower) || messageLower.includes(questionLower)) {
      score += 5;
    }

    if (item.keywords && Array.isArray(item.keywords)) {
      for (const keyword of item.keywords) {
        if (messageLower.includes(keyword.toLowerCase())) {
          score += 2;
        }
      }
    }

    const words = messageLower.split(/\s+/);
    for (const word of words) {
      if (word.length > 3 && questionLower.includes(word)) {
        score += 1;
      }
    }

    if (score > bestScore) {
      bestScore = score;
      bestMatch = item;
    }
  }

  if (bestMatch && bestScore >= 2) {
    return bestMatch.answer;
  }

  const greetings = ["hi", "hello", "hey", "merhaba", "selam"];
  const isGreeting = greetings.some(g => messageLower.includes(g));

  if (isGreeting) {
    return "Hello! How can I assist you today? Feel free to ask me anything!";
  } else if (messageLower.includes("help") || messageLower.includes("yardım")) {
    return "I'm here to help! You can ask me questions about our services. An agent will join the conversation soon if you need more assistance.";
  }

  return "I'm here to help! Could you please provide more details about your question?";
}

async function getOpenAIResponse(
  message: string,
  knowledgeBase: any[],
  settings: ChatSettings
): Promise<string> {
  try {
    const context = knowledgeBase
      .map(item => `Q: ${item.question}\nA: ${item.answer}`)
      .join('\n\n');

    const systemPrompt = settings.system_prompt || 
      'You are a helpful customer support assistant. Answer questions based on the knowledge base provided. Be concise and friendly.';

    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${settings.openai_api_key}`,
      },
      body: JSON.stringify({
        model: settings.openai_model || 'gpt-4o-mini',
        messages: [
          {
            role: 'system',
            content: `${systemPrompt}\n\nKnowledge Base:\n${context}`,
          },
          {
            role: 'user',
            content: message,
          },
        ],
        temperature: 0.7,
        max_tokens: 500,
      }),
    });

    if (!response.ok) {
      console.error('OpenAI API error:', await response.text());
      return getKnowledgeBaseResponse(message, knowledgeBase);
    }

    const data = await response.json();
    return data.choices[0]?.message?.content || 
      getKnowledgeBaseResponse(message, knowledgeBase);
  } catch (error) {
    console.error('OpenAI error:', error);
    return getKnowledgeBaseResponse(message, knowledgeBase);
  }
}

async function getOllamaResponse(
  message: string,
  knowledgeBase: any[],
  settings: ChatSettings
): Promise<string> {
  try {
    const context = knowledgeBase
      .map(item => `Q: ${item.question}\nA: ${item.answer}`)
      .join('\n\n');

    const systemPrompt = settings.system_prompt || 
      'You are a helpful customer support assistant. Answer questions based on the knowledge base provided. Be concise and friendly.';

    const response = await fetch(`${settings.ollama_url}/api/generate`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: settings.ollama_model || 'llama2',
        prompt: `${systemPrompt}\n\nKnowledge Base:\n${context}\n\nUser Question: ${message}\n\nAnswer:`,
        stream: false,
      }),
    });

    if (!response.ok) {
      console.error('Ollama API error:', await response.text());
      return getKnowledgeBaseResponse(message, knowledgeBase);
    }

    const data = await response.json();
    return data.response || getKnowledgeBaseResponse(message, knowledgeBase);
  } catch (error) {
    console.error('Ollama error:', error);
    return getKnowledgeBaseResponse(message, knowledgeBase);
  }
}