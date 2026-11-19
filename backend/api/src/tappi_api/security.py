import hashlib
import hmac as _hmac
import secrets

from .settings import settings


def hmac(value: str) -> str:
    return _hmac.new(settings().session_secret.encode(), value.encode(), hashlib.sha256).hexdigest()


def safe_equal(a: str, b: str) -> bool:
    return _hmac.compare_digest(a.encode(), b.encode())


def random_token() -> str:
    return secrets.token_urlsafe(32)


def random_code() -> str:
    return f"{secrets.randbelow(1_000_000):06d}"


# Transaction PIN: scrypt with a per-user salt, stored as "salt:hash" (hex), same as before.
def hash_pin(pin: str) -> str:
    salt = secrets.token_bytes(16)
    digest = hashlib.scrypt(pin.encode(), salt=salt, n=16384, r=8, p=1, dklen=32)
    return f"{salt.hex()}:{digest.hex()}"


def pin_matches(pin: str, stored: str) -> bool:
    salt_hex, hash_hex = stored.split(":")
    digest = hashlib.scrypt(pin.encode(), salt=bytes.fromhex(salt_hex), n=16384, r=8, p=1, dklen=32)
    return _hmac.compare_digest(digest, bytes.fromhex(hash_hex))
