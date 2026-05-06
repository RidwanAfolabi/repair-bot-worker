/**
 * Welcome to Cloudflare Workers! This is your first worker.
 *
 * - Run `npm run dev` in your terminal to start a development server
 * - Open a browser tab at http://localhost:8787/ to see your worker in action
 * - Run `npm run deploy` to publish your worker
 *
 * Learn more at https://developers.cloudflare.com/workers/
 */

export default {
	async fetch(request, env, ctx) {
		return new Response("Hello World!");
	},
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // 1. WEBHOOK VERIFICATION (GET Request from Meta)
    if (request.method === "GET") {
      const mode = url.searchParams.get("hub.mode");
      const token = url.searchParams.get("hub.verify_token");
      const challenge = url.searchParams.get("hub.challenge");

      // Replace 'YOUR_VERIFY_TOKEN' with a random string you invent
      if (mode === "subscribe" && token === "YOUR_VERIFY_TOKEN") {
        return new Response(challenge, { status: 200 });
      }
      return new Response("Forbidden", { status: 403 });
    }

    // 2. INBOUND MESSAGE HANDLER (POST Request from Meta)
    if (request.method === "POST") {
      const payload = await request.json();
      
      // Log it to see the structure in Cloudflare dashboard
      console.log("New Message:", JSON.stringify(payload, null, 2));

      // Immediate 200 OK so Meta doesn't retry
      return new Response("EVENT_RECEIVED", { status: 200 });
    }

    return new Response("Method Not Allowed", { status: 405 });
  }
};