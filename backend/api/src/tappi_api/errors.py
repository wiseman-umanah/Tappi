from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse


class HttpError(Exception):
    """A message meant for the user. Responses are `{"error": message}`, as the app expects."""

    def __init__(self, status: int, message: str):
        self.status = status
        self.message = message


def install(app: FastAPI) -> None:
    @app.exception_handler(HttpError)
    async def _http_error(_: Request, error: HttpError) -> JSONResponse:
        return JSONResponse({"error": error.message}, status_code=error.status)

    @app.exception_handler(RequestValidationError)
    async def _validation(_: Request, error: RequestValidationError) -> JSONResponse:
        first = error.errors()[0] if error.errors() else {}
        message = first.get("ctx", {}).get("error") or first.get("msg") or "Invalid request"
        return JSONResponse({"error": str(message).removeprefix("Value error, ")}, status_code=400)
