import { getAuthenticatedUser } from "../_shared/auth.js";
import { errorResponse, jsonResponse } from "../_shared/http.js";

export async function onRequestGet({ request, env }) {
  const user = await getAuthenticatedUser(request, env);
  if (!user) {
    return errorResponse("Cloudflare Access identity is required.", 401);
  }

  return jsonResponse({
    email: user.email,
    name: user.name || "",
    source: user.source,
  });
}
