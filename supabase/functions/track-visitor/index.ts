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
    const { conversation_id } = await req.json();

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseKey);

    const clientIp = req.headers.get("x-forwarded-for") || 
                     req.headers.get("x-real-ip") || 
                     "unknown";

    let locationData = null;

    if (clientIp && clientIp !== "unknown") {
      try {
        const geoResponse = await fetch(`https://ipapi.co/${clientIp}/json/`);
        if (geoResponse.ok) {
          locationData = await geoResponse.json();
        }
      } catch (error) {
        console.error("Geolocation error:", error);
      }
    }

    const { data: conversation } = await supabase
      .from("conversations")
      .select("metadata")
      .eq("id", conversation_id)
      .single();

    const updatedMetadata = {
      ...conversation?.metadata,
      ip_address: clientIp,
      location: locationData ? {
        country: locationData.country_name,
        country_code: locationData.country_code,
        city: locationData.city,
        region: locationData.region,
        postal: locationData.postal,
        latitude: locationData.latitude,
        longitude: locationData.longitude,
        timezone: locationData.timezone,
        isp: locationData.org
      } : null
    };

    await supabase
      .from("conversations")
      .update({ metadata: updatedMetadata })
      .eq("id", conversation_id);

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
