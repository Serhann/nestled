import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, {
      status: 200,
      headers: corsHeaders,
    });
  }

  try {
    const { conversation_id, message_id, type } = await req.json();

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseKey);

    const { data: settings } = await supabase
      .from("chat_settings")
      .select("discord_webhook_url, discord_webhook_enabled, discord_notify_new_chat, discord_notify_new_message")
      .maybeSingle();

    if (!settings || !settings.discord_webhook_enabled || !settings.discord_webhook_url) {
      return new Response(
        JSON.stringify({ success: false, message: "Discord webhook not configured" }),
        {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    if (type === "new_chat" && !settings.discord_notify_new_chat) {
      return new Response(
        JSON.stringify({ success: false, message: "New chat notifications disabled" }),
        {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    if (type === "new_message" && !settings.discord_notify_new_message) {
      return new Response(
        JSON.stringify({ success: false, message: "New message notifications disabled" }),
        {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    const { data: conversation } = await supabase
      .from("conversations")
      .select("visitor_name, visitor_email, visitor_id, metadata, created_at")
      .eq("id", conversation_id)
      .single();

    if (!conversation) {
      return new Response(
        JSON.stringify({ success: false, message: "Conversation not found" }),
        {
          status: 404,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    let embed: any;

    if (type === "new_chat") {
      const visitorName = conversation.visitor_name || "Anonymous";
      const visitorEmail = conversation.visitor_email || "Not provided";
      const location = conversation.metadata?.location;
      const currentPage = conversation.metadata?.current_page || "Unknown";

      embed = {
        title: "🆕 New Chat Started",
        color: 3447003,
        fields: [
          {
            name: "Visitor",
            value: visitorName,
            inline: true
          },
          {
            name: "Email",
            value: visitorEmail,
            inline: true
          },
          {
            name: "Current Page",
            value: currentPage,
            inline: false
          }
        ],
        timestamp: conversation.created_at,
        footer: {
          text: "Chat System"
        }
      };

      if (location) {
        embed.fields.push({
          name: "Location",
          value: `${location.city || 'Unknown'}, ${location.country || 'Unknown'}`,
          inline: true
        });
      }
    } else if (type === "new_message" && message_id) {
      const { data: message } = await supabase
        .from("messages")
        .select("content, sender_type, created_at")
        .eq("id", message_id)
        .single();

      if (!message) {
        return new Response(
          JSON.stringify({ success: false, message: "Message not found" }),
          {
            status: 404,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          }
        );
      }

      if (message.sender_type !== "visitor") {
        return new Response(
          JSON.stringify({ success: false, message: "Only visitor messages trigger notifications" }),
          {
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          }
        );
      }

      const visitorName = conversation.visitor_name || "Anonymous";
      const messageContent = message.content.length > 200 
        ? message.content.substring(0, 200) + "..."
        : message.content;

      embed = {
        title: "💬 New Message",
        description: messageContent,
        color: 15844367,
        fields: [
          {
            name: "From",
            value: visitorName,
            inline: true
          }
        ],
        timestamp: message.created_at,
        footer: {
          text: "Chat System"
        }
      };
    } else {
      return new Response(
        JSON.stringify({ success: false, message: "Invalid notification type" }),
        {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    const discordPayload = {
      embeds: [embed]
    };

    const discordResponse = await fetch(settings.discord_webhook_url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(discordPayload),
    });

    if (!discordResponse.ok) {
      console.error("Discord webhook error:", await discordResponse.text());
      return new Response(
        JSON.stringify({ success: false, message: "Failed to send Discord notification" }),
        {
          status: 500,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    return new Response(
      JSON.stringify({ success: true }),
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