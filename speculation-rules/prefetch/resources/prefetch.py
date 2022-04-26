from wptserve.handlers import json_handler

@json_handler
def main(request, response):
  origin = request.GET[b"origin"] if b"origin" in request.GET else None
  if origin is not None:
    response.headers.set(b"Access-Control-Allow-Origin", origin)
    response.headers.set(b"Access-Control-Allow-Credentials", b"true")

  uuid = request.GET[b"uuid"]
  prefetch = request.headers.get(
      "Sec-Purpose", b"").decode("utf-8").startswith("prefetch")

  cookie_count = int(
      request.cookies[b"count"].value) if b"count" in request.cookies else 0
  response.set_cookie("count", f"{cookie_count+1}",
                      secure=True, samesite="None")

  prefetch_count = request.server.stash.take(uuid)
  if prefetch_count is None:
    prefetch_count = 0
  if prefetch:
    prefetch_count += 1
    request.server.stash.put(uuid, prefetch_count)

  return {"prefetch": prefetch_count, "cookie": cookie_count}
