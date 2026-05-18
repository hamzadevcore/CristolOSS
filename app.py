import json
import os
import re
import uuid
import hashlib
import requests
import logging
import time
import copy
import concurrent.futures
import math
import secrets
from werkzeug.middleware.proxy_fix import ProxyFix
from datetime import datetime, timedelta, timezone
from pathlib import Path
from functools import wraps, lru_cache
from flask import Flask, request, jsonify, Response, make_response, copy_current_request_context, g
from flask_compress import Compress
from dotenv import load_dotenv
from flask_sqlalchemy import SQLAlchemy
from sqlalchemy import func, String, cast
from flask_jwt_extended import (
    JWTManager,
    create_access_token,
    create_refresh_token,
    jwt_required,
    get_jwt_identity,
    decode_token,
    set_refresh_cookies,
    unset_jwt_cookies,
)
import smtplib
from email.mime.text import MIMEText
from email.mime.multipart import MIMEMultipart
import random
from werkzeug.security import generate_password_hash, check_password_hash
from sqlalchemy.orm.attributes import flag_modified
from google.oauth2 import id_token
from google.auth.transport import requests as google_requests
from collections import defaultdict
import threading

try:
    import redis
except ImportError:
    redis = None

try:
    import phonenumbers
except ImportError:
    phonenumbers = None

try:
    from twilio.base.exceptions import TwilioRestException
    from twilio.rest import Client as TwilioClient
except ImportError:
    TwilioRestException = Exception
    TwilioClient = None

json_dumps = json.dumps
requests_session = requests.Session()
requests_session.mount('https://', requests.adapters.HTTPAdapter(pool_connections=10, pool_maxsize=20, pool_block=False))

log = logging.getLogger('werkzeug')
log.setLevel(logging.ERROR)
app_logger = logging.getLogger('cristol')
app_logger.setLevel(logging.DEBUG)
handler = logging.StreamHandler()
handler.setFormatter(logging.Formatter('%(asctime)s[%(levelname)s] %(message)s'))
app_logger.addHandler(handler)

BASE_DIR = Path(__file__).resolve().parent
dotenv_path = BASE_DIR.parent / '.env'
if dotenv_path.exists():
    load_dotenv(dotenv_path)

app = Flask(__name__)
app.config['MAX_CONTENT_LENGTH'] = 2 * 1024 * 1024

app.wsgi_app = ProxyFix(app.wsgi_app, x_for=1, x_proto=1, x_host=1, x_prefix=1)

def env_flag(name: str, default: bool = False) -> bool:
    raw = os.getenv(name)
    if raw is None:
        return default
    return raw.strip().lower() in {'1', 'true', 'yes', 'on'}

APP_BASE_URL = os.getenv('APP_BASE_URL', 'http://localhost:5173').strip() or 'http://localhost:5173'
COOKIE_SECURE = env_flag('COOKIE_SECURE', False)
COOKIE_SAMESITE = os.getenv('COOKIE_SAMESITE', 'Lax').strip() or 'Lax'
DEVICE_COOKIE_NAME = os.getenv('DEVICE_COOKIE_NAME', 'cristol_device_id').strip() or 'cristol_device_id'
FREE_TIER_GRANT_CREDITS = float(os.getenv('FREE_TIER_GRANT_CREDITS', '75'))
TURNSTILE_SECRET_KEY = os.getenv('TURNSTILE_SECRET_KEY', '').strip()
REDIS_URL = os.getenv('REDIS_URL', '').strip()
TWILIO_ACCOUNT_SID = os.getenv('TWILIO_ACCOUNT_SID', '').strip()
TWILIO_AUTH_TOKEN = os.getenv('TWILIO_AUTH_TOKEN', '').strip()
TWILIO_VERIFY_SERVICE_SID = os.getenv('TWILIO_VERIFY_SERVICE_SID', '').strip()

def load_allowed_origins() -> set[str]:
    raw = os.getenv('ALLOWED_ORIGINS', '').strip()
    if raw:
        values = {item.strip() for item in raw.split(',') if item.strip()}
        return values or {'*'}
    return {
        APP_BASE_URL,
        "http://localhost:5173",
        "http://192.168.100.100:5173",
    }

ALLOWED_ORIGINS = load_allowed_origins()

try:
    import stripe
    stripe.api_key = os.getenv('STRIPE_SECRET_KEY')
except ImportError:
    stripe = None

TIER_CONFIG = {
    "Free": {
        "credits_per_month": 0, "max_instances": 1, "max_episodes": 3,
        "max_episode_length": 8000, "max_lore_length": 800,
        "max_profile_length": 800, "storage_mb": 5, "retention_days": 30,
        "auto_summaries": False, "sharing": "read_only", "full_sharing": False,
        "branches": False, "priority_processing": False, "bulk_import": False,
        "plus_trial_days": 0, "price_monthly": 0, "price_annual": 0,
    },
    "Basic": {
        "credits_per_month": 200, "max_instances": 2, "max_episodes": 5,
        "max_episode_length": 10000, "max_lore_length": 1000,
        "max_profile_length": 1000, "storage_mb": 25, "retention_days": 180,
        "auto_summaries": False, "sharing": "read_only", "full_sharing": False,
        "branches": False, "priority_processing": False, "bulk_import": False,
        "plus_trial_days": 3, "price_monthly": 7.99, "price_annual": 79.99,
    },
    "Plus": {
        "credits_per_month": 600, "max_instances": 5, "max_episodes": 15,
        "max_episode_length": 20000, "max_lore_length": 4000,
        "max_profile_length": 4000, "storage_mb": 100, "retention_days": 365,
        "auto_summaries": True, "sharing": "full", "full_sharing": True,
        "branches": False, "priority_processing": False, "bulk_import": False,
        "plus_trial_days": 0, "price_monthly": 19.99, "price_annual": 199.99,
    },
    "Pro": {
        "credits_per_month": 1200, "max_instances": 20, "max_episodes": 45,
        "max_episode_length": 100000000, "max_lore_length": 12000,
        "max_profile_length": 12000, "storage_mb": 500, "retention_days": None,
        "auto_summaries": True, "sharing": "full", "full_sharing": True,
        "branches": True, "priority_processing": True, "bulk_import": True,
        "plus_trial_days": 0, "price_monthly": 34.99, "price_annual": 349.99,
    },
}

CREDIT_PACKS = {
    "small": {"name": "Small Pack", "credits": 150, "price": 3.99, "available_tiers":["Basic", "Plus", "Pro"]},
    "medium": {"name": "Medium Pack", "credits": 400, "price": 9.99, "available_tiers":["Basic", "Plus", "Pro"]},
    "large": {"name": "Large Pack", "credits": 900, "price": 19.99, "available_tiers":["Basic", "Plus", "Pro"]},
}

# Reserved for future credit addon products (kept as empty dict to avoid NameError)
CREDIT_ADDONS: dict = {}

CREDIT_CONVERSION_RATE = 0.015
CANCELLATION_CREDIT_COST = 1.0
MAX_CANCELLATIONS_PER_HOUR = 60

MAX_RECENT_MESSAGES = 6
MAX_HISTORY_BEFORE_SUMMARY = 10
MAX_SUMMARY_WORDS = 800
MAX_PROMPT_TOKENS_SOFT_LIMIT = 18000
 
# ── Token Budget ──────────────────────────────────────────────────────────────
MAX_TOTAL_TOKENS   = 8192   # hard cap on total input tokens
MAX_SYSTEM_TOKENS  =  4096   # budget for system message (prompt+lore+profile+chunk)
MAX_HISTORY_TOKENS =  4096   # budget for conversation history
CHARS_PER_TOKEN    =      4   # rough estimate: 1 token ≈ 4 characters
 
 
def estimate_tokens(text: str) -> int:
    """Rough 1-token-per-4-chars estimate (no external dependency)."""
    return max(0, len(text or '')) // CHARS_PER_TOKEN
 
 
def _trim_to_tokens(text: str, max_tokens: int) -> str:
    return text

# ── AI Chunk Picker ────────────────────────────────────────────────────────────
CHUNK_COMPLETE_TAG        = "\n\n[CHUNK_COMPLETE]"
AI_PICKER_HISTORY_WINDOW  = 5

SLIDING_WINDOW_PREV_SENTENCES = 3
SLIDING_WINDOW_NEXT_SENTENCES = 3

CHUNK_MODES = ['auto', 'manual']
# Whitelisted keys a client may set on an instance via PUT
INSTANCE_CLIENT_SETTABLE_KEYS = frozenset([
    'lore', 'profile', 'currentEpisodeIndex', 'summaryHistory', 'episodes',
    'rollingSummary', 'rollingSummaryCount', 'transcript_progress',
    'current_chunk_id', 'played_segments', 'settings',
])

INSTANCE_SETTINGS_ALLOWED_KEYS = frozenset(['chunk_mode'])

def get_tier_config(tier_name):
    return TIER_CONFIG.get(tier_name, TIER_CONFIG["Free"]).copy()

@lru_cache(maxsize=4)
def get_tier_config_cached(tier_name):
    return TIER_CONFIG.get(tier_name, TIER_CONFIG["Free"])

@app.before_request
def handle_preflight():
    if request.method == "OPTIONS":
        response = make_response()
        origin = request.headers.get("Origin")
        if origin and origin in ALLOWED_ORIGINS and '*' not in ALLOWED_ORIGINS:
            response.headers["Access-Control-Allow-Origin"] = origin
            response.headers["Vary"] = "Origin"
            response.headers["Access-Control-Allow-Credentials"] = "true"
        elif origin and '*' in ALLOWED_ORIGINS:
            response.headers["Access-Control-Allow-Origin"] = "*"
            response.headers["Access-Control-Allow-Credentials"] = "false"
        response.headers["Access-Control-Allow-Headers"] = "Authorization, Content-Type, X-Requested-With"
        response.headers["Access-Control-Allow-Methods"] = "GET, POST, PUT, DELETE, OPTIONS"
        return response

@app.after_request
def add_cors_headers(response):
    origin = request.headers.get("Origin")
    if origin and origin in ALLOWED_ORIGINS and '*' not in ALLOWED_ORIGINS:
        response.headers["Access-Control-Allow-Origin"] = origin
        response.headers["Vary"] = "Origin"
        response.headers["Access-Control-Allow-Credentials"] = "true"
    elif origin and '*' in ALLOWED_ORIGINS:
        response.headers["Access-Control-Allow-Origin"] = "*"
        response.headers["Access-Control-Allow-Credentials"] = "false"
    response.headers["Access-Control-Allow-Headers"] = "Authorization, Content-Type, X-Requested-With"
    response.headers["Access-Control-Allow-Methods"] = "GET, POST, PUT, DELETE, OPTIONS"
    response.headers["Content-Security-Policy"] = "frame-ancestors *"
    response.headers.pop("X-Frame-Options", None)
    if hasattr(g, 'new_device_id'):
        response.set_cookie(
            DEVICE_COOKIE_NAME,
            g.new_device_id,
            max_age=60 * 60 * 24 * 365,
            httponly=True,
            secure=COOKIE_SECURE,
            samesite=COOKIE_SAMESITE,
            path='/',
        )
    return response

@app.errorhandler(Exception)
def handle_exception(e):
    app_logger.error(f"Unhandled Exception: {e}", exc_info=True)
    if hasattr(e, 'get_response'):
        return e.get_response()
    if app.debug:
        return jsonify({"error": "Internal Server Error", "details": str(e)}), 500
    return jsonify({"error": "Internal Server Error"}), 500

db_url = os.getenv('DATABASE_URL')
if db_url:
    db_url = db_url.strip('"\'')
    if db_url.startswith('postgres://'):
        db_url = db_url.replace('postgres://', 'postgresql://', 1)
    if db_url.startswith('sqlite'):
        db_path = BASE_DIR / 'cristol.db'
        db_url = f"sqlite:///{db_path.as_posix()}"
else:
    db_path = BASE_DIR / 'cristol.db'
    db_url = f"sqlite:///{db_path.as_posix()}"

app.config['SQLALCHEMY_DATABASE_URI'] = db_url
app.config['SQLALCHEMY_TRACK_MODIFICATIONS'] = False
sqlalchemy_engine_options = {
    'pool_recycle': 3600,
    'pool_pre_ping': True,
}
if db_url.startswith('sqlite'):
    sqlalchemy_engine_options['connect_args'] = {'timeout': 30}
else:
    sqlalchemy_engine_options['pool_size'] = 20
app.config['SQLALCHEMY_ENGINE_OPTIONS'] = sqlalchemy_engine_options
jwt_secret = os.getenv('JWT_SECRET')
if not jwt_secret:
    raise ValueError("CRITICAL: JWT_SECRET environment variable is missing. Users will be logged out on restart.")
app.config['JWT_SECRET_KEY'] = jwt_secret
app.config['JWT_ACCESS_TOKEN_EXPIRES'] = timedelta(minutes=15)
app.config['JWT_REFRESH_TOKEN_EXPIRES'] = timedelta(days=30)
app.config['JWT_TOKEN_LOCATION'] = ['headers', 'cookies']
app.config['JWT_HEADER_NAME'] = 'Authorization'
app.config['JWT_HEADER_TYPE'] = 'Bearer'
app.config['JWT_COOKIE_SECURE'] = COOKIE_SECURE
app.config['JWT_COOKIE_SAMESITE'] = COOKIE_SAMESITE
app.config['JWT_COOKIE_CSRF_PROTECT'] = COOKIE_SECURE
app.config['JWT_REFRESH_COOKIE_PATH'] = '/api/auth'
app.config['JSON_SORT_KEYS'] = False
app.config['JSON_AS_ASCII'] = False

GOOGLE_CLIENT_ID = os.getenv('GOOGLE_CLIENT_ID')

db = SQLAlchemy(app)
jwt = JWTManager(app)
Compress(app)

REDIS_CLIENT = None
if REDIS_URL and redis is not None:
    try:
        REDIS_CLIENT = redis.Redis.from_url(REDIS_URL, decode_responses=True)
        REDIS_CLIENT.ping()
    except Exception as e:
        app_logger.warning(f"Redis unavailable, falling back to in-memory counters: {e}")
        REDIS_CLIENT = None

TWILIO_VERIFY_CLIENT = None
if TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN and TWILIO_VERIFY_SERVICE_SID and TwilioClient is not None:
    try:
        TWILIO_VERIFY_CLIENT = TwilioClient(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN)
    except Exception as e:
        app_logger.warning(f"Twilio client unavailable: {e}")
        TWILIO_VERIFY_CLIENT = None

class PersistentCounterStore:
    """
    Handles rate limiting and abuse prevention counters.
    It uses Redis if available for persistence across server restarts and multiple workers,
    otherwise it falls back to an in-memory store for local development.
    """
    def __init__(self, redis_client=None):
        self.redis = redis_client
        self._local_counts = defaultdict(int)
        self._local_expiry = {}
        self._lock = threading.Lock()

    def _cleanup_local(self, key: str):
        now = time.time()
        expires_at = self._local_expiry.get(key)
        if expires_at is not None and expires_at <= now:
            self._local_counts.pop(key, None)
            self._local_expiry.pop(key, None)

    def get_count(self, key: str) -> int:
        if self.redis is not None:
            try:
                raw = self.redis.get(key)
                return int(raw or 0)
            except Exception:
                pass
        with self._lock:
            self._cleanup_local(key)
            return int(self._local_counts.get(key, 0))

    def get_ttl(self, key: str, window: int) -> int:
        if self.redis is not None:
            try:
                ttl = int(self.redis.ttl(key))
                return max(ttl, 0)
            except Exception:
                pass
        with self._lock:
            self._cleanup_local(key)
            expires_at = self._local_expiry.get(key)
            if expires_at is None:
                return 0
            return max(int(expires_at - time.time()), 0)

    def increment(self, key: str, window: int, amount: int = 1) -> tuple[int, int]:
        if self.redis is not None:
            try:
                pipe = self.redis.pipeline()
                pipe.incrby(key, amount)
                pipe.expire(key, window, nx=True)
                pipe.ttl(key)
                count, _, ttl = pipe.execute()
                return int(count or 0), max(int(ttl or window), 0)
            except Exception:
                pass
        with self._lock:
            self._cleanup_local(key)
            if key not in self._local_expiry:
                self._local_expiry[key] = time.time() + window
            self._local_counts[key] = int(self._local_counts.get(key, 0)) + amount
            ttl = max(int(self._local_expiry[key] - time.time()), 0)
            return int(self._local_counts[key]), ttl

    def reset(self, key: str):
        if self.redis is not None:
            try:
                self.redis.delete(key)
                return
            except Exception:
                pass
        with self._lock:
            self._local_counts.pop(key, None)
            self._local_expiry.pop(key, None)


counter_store = PersistentCounterStore(REDIS_CLIENT)

import hmac

def sha256_text(value: str) -> str:
    pepper = os.getenv('PEPPER_SECRET')
    if not pepper:
        raise ValueError("CRITICAL: PEPPER_SECRET environment variable is missing.")
    secret_key = pepper.encode('utf-8')
    return hmac.new(secret_key, (value or '').encode('utf-8'), hashlib.sha256).hexdigest()

def extract_client_ip() -> str:
    # ProxyFix makes request.remote_addr secure and accurate
    return request.remote_addr or "unknown"

def get_public_base_url() -> str:
    origin = request.headers.get('Origin', '').strip()
    if origin and ('*' in ALLOWED_ORIGINS or origin in ALLOWED_ORIGINS):
        return origin
    return APP_BASE_URL

def get_or_create_device_id() -> str:
    existing = request.cookies.get(DEVICE_COOKIE_NAME, '').strip()
    if existing:
        return existing
    new_value = uuid.uuid4().hex
    g.new_device_id = new_value
    return new_value

def get_device_hash() -> str:
    return sha256_text(get_or_create_device_id())

def get_ip_hash() -> str:
    return sha256_text(extract_client_ip())

def load_disposable_email_domains() -> set[str]:
    path = BASE_DIR / 'disposable_email_domains.txt'
    defaults = {
        '10minutemail.com',
        'guerrillamail.com',
        'mailinator.com',
        'temp-mail.org',
        'tempmail.com',
        'yopmail.com',
    }
    if not path.exists():
        return defaults
    loaded = set(defaults)
    try:
        for line in path.read_text(encoding='utf-8').splitlines():
            value = line.strip().lower()
            if value and not value.startswith('#'):
                loaded.add(value)
    except Exception as e:
        app_logger.warning(f"Failed to load disposable email denylist: {e}")
    return loaded

DISPOSABLE_EMAIL_DOMAINS = load_disposable_email_domains()

def is_disposable_email(email: str) -> bool:
    domain = email.partition('@')[2].strip().lower()
    return bool(domain) and domain in DISPOSABLE_EMAIL_DOMAINS

def verify_turnstile(turnstile_token: str) -> tuple:
    if not TURNSTILE_SECRET_KEY:
        return (True, None) if not env_flag('REQUIRE_TURNSTILE', False) else (False, "Turnstile is not configured")
    if not turnstile_token:
        return False, "Turnstile verification is required"
    try:
        resp = requests_session.post(
            "https://challenges.cloudflare.com/turnstile/v0/siteverify",
            data={
                "secret": TURNSTILE_SECRET_KEY,
                "response": turnstile_token,
                "remoteip": extract_client_ip(),
            },
            timeout=5,
        )
        payload = resp.json()
        if payload.get("success"):
            return True, None
        return False, ", ".join(payload.get("error-codes", []) or ["turnstile_failed"])
    except Exception as e:
        app_logger.warning(f"Turnstile verification failed: {e}")
        return False, "Turnstile verification failed"

def normalize_phone_number(raw_phone: str) -> tuple:
    if not raw_phone:
        return None, "Phone number required"
    if phonenumbers is None:
        digits = ''.join(ch for ch in raw_phone if ch.isdigit() or ch == '+')
        if len(digits) < 8:
            return None, "Enter a valid phone number"
        return digits if digits.startswith('+') else f"+{digits}", None
    try:
        parsed = phonenumbers.parse(raw_phone, None)
        if not phonenumbers.is_valid_number(parsed):
            return None, "Enter a valid phone number"
        return phonenumbers.format_number(parsed, phonenumbers.PhoneNumberFormat.E164), None
    except Exception:
        return None, "Enter a valid phone number"

def mask_phone_number(phone_number):
    if not phone_number:
        return None
    digits = ''.join(ch for ch in phone_number if ch.isdigit())
    if len(digits) < 4:
        return phone_number
    return f"+*** *** {digits[-4:]}"

def start_phone_verification(phone_number: str) -> tuple:
    if TWILIO_VERIFY_CLIENT is None or not TWILIO_VERIFY_SERVICE_SID:
        return False, "Phone verification is not configured"
    try:
        TWILIO_VERIFY_CLIENT.verify.v2.services(TWILIO_VERIFY_SERVICE_SID).verifications.create(
            to=phone_number,
            channel='sms',
        )
        return True, None
    except TwilioRestException as e:
        app_logger.warning(f"Twilio verification start failed: {e}")
        return False, getattr(e, 'msg', str(e))
    except Exception as e:
        app_logger.warning(f"Twilio verification start failed: {e}")
        return False, "Failed to send verification code"

def check_phone_verification(phone_number: str, code: str) -> tuple:
    if TWILIO_VERIFY_CLIENT is None or not TWILIO_VERIFY_SERVICE_SID:
        return False, "Phone verification is not configured"
    try:
        check = TWILIO_VERIFY_CLIENT.verify.v2.services(TWILIO_VERIFY_SERVICE_SID).verification_checks.create(
            to=phone_number,
            code=code,
        )
        if check.status == 'approved':
            return True, None
        return False, "Invalid verification code"
    except TwilioRestException as e:
        app_logger.warning(f"Twilio verification check failed: {e}")
        return False, getattr(e, 'msg', str(e))
    except Exception as e:
        app_logger.warning(f"Twilio verification check failed: {e}")
        return False, "Phone verification failed"

@jwt.expired_token_loader
def expired_token_callback(jwt_header, jwt_payload):
    return jsonify({"error": "Token has expired", "code": "token_expired"}), 401

@jwt.invalid_token_loader
def invalid_token_callback(error):
    return jsonify({"error": f"Invalid token: {error}", "code": "invalid_token"}), 401

@jwt.unauthorized_loader
def missing_token_callback(error):
    return jsonify({"error": f"Authorization required: {error}", "code": "missing_token"}), 401

@jwt.revoked_token_loader
def revoked_token_callback(jwt_header, jwt_payload):
    return jsonify({"error": "Token has been revoked", "code": "token_revoked"}), 401

OPENROUTER_API_URL = "https://openrouter.ai/api/v1"
COST_SAVING_MODE = os.getenv('COST_SAVING_MODE', 'false').lower() in {'1', 'true', 'yes', 'on'}
SMTP_SERVER = os.getenv('SMTP_SERVER', 'smtp.gmail.com')
SMTP_PORT = int(os.getenv('SMTP_PORT', 587))
SMTP_USER = os.getenv('SMTP_USER', '').strip()
SMTP_PASS = os.getenv('SMTP_PASS', '').strip()
SERVER_API_KEY = os.getenv('OPENROUTER_API_KEY', '').strip()
DEFAULT_SUMMARIZATION_MODEL = os.getenv('SUMMARIZATION_MODEL', 'x-ai/grok-4.1-fast')
DEFAULT_CHAT_MODEL = "anthropic/claude-sonnet-4"

DEFAULT_MODELS =[
    {"id": "google/gemma-4-31b-it", "name": "Gemma 4 31b", "min_cost": 1.0},
    {"id": "z-ai/glm-5.1", "name": "GLM 5.1", "min_cost": 1.0},
    {"id": "xiaomi/mimo-v2-omni", "name": "MiMo V2 Omni", "min_cost": 1.0},
]

def load_models_config():
    return DEFAULT_MODELS

def get_default_chat_model():
    return DEFAULT_MODELS[0].get("id", DEFAULT_CHAT_MODEL)

def get_model_min_cost(model_id: str) -> float:
    for m in DEFAULT_MODELS:
        if m["id"] == model_id:
            return float(m.get("min_cost", 1.0))
    return 1.0

def generate_unique_id(prefix=""):
    return f"{prefix}{secrets.token_hex(16)}"

def get_utc_now():
    return datetime.now(timezone.utc).replace(tzinfo=None)

class User(db.Model):
    __tablename__ = 'users'
    id = db.Column(db.Integer, primary_key=True)
    email = db.Column(db.String(120), unique=True, nullable=False)
    password_hash = db.Column(db.String(256), nullable=True)
    google_id = db.Column(db.String(120), unique=True, nullable=True)
    generation_locked_until = db.Column(db.DateTime, nullable=True)
    phone_number = db.Column(db.String(20), unique=True, nullable=True)
    phone_verified = db.Column(db.Boolean, default=False)
    phone_verified_at = db.Column(db.DateTime, nullable=True)
    created_at = db.Column(db.DateTime, default=get_utc_now)
    is_verified = db.Column(db.Boolean, default=False)
    verification_code = db.Column(db.String(256), nullable=True)
    verification_sent_at = db.Column(db.DateTime, nullable=True)
    subscription_tier = db.Column(db.String(50), default="Free")
    subscription_started_at = db.Column(db.DateTime, nullable=True)
    subscription_ends_at = db.Column(db.DateTime, nullable=True)
    billing_cycle = db.Column(db.String(20), default="monthly")
    stripe_customer_id = db.Column(db.String(100), nullable=True)
    stripe_subscription_id = db.Column(db.String(100), nullable=True)
    credits = db.Column(db.Float, default=75.0)
    credits_reset_at = db.Column(db.DateTime, nullable=True)
    credit_addon = db.Column(db.String(50), nullable=True)
    free_grant_status = db.Column(db.String(50), default="pending_phone")
    free_grant_claimed_at = db.Column(db.DateTime, nullable=True)
    plus_trial_started_at = db.Column(db.DateTime, nullable=True)
    plus_trial_days_used = db.Column(db.Integer, default=0)
    plus_trial_last_active_date = db.Column(db.Date, nullable=True)
    chat_model = db.Column(db.String(100), default=get_default_chat_model)
    summary_model = db.Column(db.String(100), default=DEFAULT_SUMMARIZATION_MODEL)
    chunk_model = db.Column(db.String(100), default=DEFAULT_SUMMARIZATION_MODEL)
    chunk_selection_mode = db.Column(db.String(20), default="auto")
    last_active_at = db.Column(db.DateTime, default=get_utc_now)
    device_id_hash = db.Column(db.String(64), nullable=True)
    signup_ip_hash = db.Column(db.String(64), nullable=True)
    last_ip_hash = db.Column(db.String(64), nullable=True)
    risk_state = db.Column(db.String(50), default="clear")
    risk_reason = db.Column(db.String(255), nullable=True)
    content_expires_at = db.Column(db.DateTime, nullable=True)
    pending_deletion_at = db.Column(db.DateTime, nullable=True)
    deletion_warning_level = db.Column(db.Integer, default=0)
    is_admin = db.Column(db.Boolean, default=False)

    def get_effective_tier_config(self):
        config = get_tier_config(self.subscription_tier)
        if self.subscription_tier == "Basic" and self.is_in_plus_trial():
            plus_config = get_tier_config("Plus")
            for k, v in plus_config.items():
                config[k] = v
            config["credits_per_month"] = get_tier_config("Basic")["credits_per_month"]
        return config

    def is_in_plus_trial(self):
        if self.subscription_tier != "Basic":
            return False
        if self.plus_trial_days_used >= 3:
            return False
        return True

    def record_plus_trial_day(self):
        if self.subscription_tier != "Basic":
            return
        today = datetime.now(timezone.utc).date()
        if self.plus_trial_last_active_date != today:
            self.plus_trial_last_active_date = today
            self.plus_trial_days_used += 1
            if self.plus_trial_started_at is None:
                self.plus_trial_started_at = get_utc_now()

    def get_total_credits(self):
        config = get_tier_config(self.subscription_tier)
        total = float(config["credits_per_month"])
        if self.credit_addon and self.credit_addon in CREDIT_ADDONS:
            total += float(CREDIT_ADDONS[self.credit_addon]["credits"])
        return total

    def get_display_credit_total(self):
        return max(float(self.get_total_credits()), float(self.credits or 0))

    def should_reset_credits(self):
        if self.subscription_tier == "Free":
            return False
        if self.credits_reset_at is None:
            return True
        now = get_utc_now()
        reset_at = self.credits_reset_at
        if reset_at.tzinfo is not None:
            reset_at = reset_at.replace(tzinfo=None)
        return now >= reset_at

    def reset_credits(self):
        if self.subscription_tier == "Free":
            self.credits_reset_at = None
            return
        self.credits = float(self.get_total_credits())
        self.credits_reset_at = get_utc_now() + timedelta(days=30)

    def deduct_credit(self, amount=1.0):
        safe_amount = max(0.0, float(amount))
        User.query.filter_by(id=self.id).update(
            {"credits": func.greatest(0, User.credits - safe_amount)},
            synchronize_session='fetch'
        )
        db.session.commit()
        db.session.refresh(self, ['credits'])
        return True

    def update_content_expiry(self):
        config = get_tier_config(self.subscription_tier)
        retention_days = config.get("retention_days")
        if retention_days is None:
            self.content_expires_at = None
        else:
            self.content_expires_at = get_utc_now() + timedelta(days=retention_days)
        self.last_active_at = get_utc_now()


class VerifiedPhoneClaim(db.Model):
    __tablename__ = 'verified_phone_claims'
    id = db.Column(db.Integer, primary_key=True)
    phone_hash = db.Column(db.String(64), unique=True, nullable=False)
    user_id = db.Column(db.Integer, db.ForeignKey('users.id'), nullable=True)
    device_id_hash = db.Column(db.String(64), nullable=True)
    claimed_at = db.Column(db.DateTime, default=get_utc_now)
    source = db.Column(db.String(50), nullable=True)

class ShowModel(db.Model):
    __tablename__ = 'shows'
    id = db.Column(db.String(80), primary_key=True)
    user_id = db.Column(db.Integer, db.ForeignKey('users.id'), nullable=False)
    data = db.Column(db.JSON, nullable=False)
    created_at = db.Column(db.DateTime, default=get_utc_now)
    is_archived = db.Column(db.Boolean, default=False)
    marked_for_deletion = db.Column(db.Boolean, default=False)

class InstanceModel(db.Model):
    __tablename__ = 'instances'
    id = db.Column(db.String(80), primary_key=True)
    user_id = db.Column(db.Integer, db.ForeignKey('users.id'), nullable=False)
    data = db.Column(db.JSON, nullable=False)
    created_at = db.Column(db.DateTime, default=get_utc_now)
    is_archived = db.Column(db.Boolean, default=False)
    marked_for_deletion = db.Column(db.Boolean, default=False)

class AnalyticsEvent(db.Model):
    __tablename__ = 'analytics_events'
    id = db.Column(db.Integer, primary_key=True)
    user_id = db.Column(db.Integer, db.ForeignKey('users.id'), nullable=True)
    event_type = db.Column(db.String(50), nullable=False)
    from_tier = db.Column(db.String(20), nullable=True)
    to_tier = db.Column(db.String(20), nullable=True)
    event_data = db.Column(db.JSON, nullable=True)
    created_at = db.Column(db.DateTime, default=get_utc_now)

class FinetuningLog(db.Model):
    __tablename__ = 'finetuning_logs'
    id = db.Column(db.Integer, primary_key=True)
    prompt_hash = db.Column(db.String(64), index=True, nullable=False)
    messages = db.Column(db.JSON, nullable=False)
    created_at = db.Column(db.DateTime, default=get_utc_now)
    updated_at = db.Column(db.DateTime, default=get_utc_now, onupdate=get_utc_now)

class ChunkSelectionLog(db.Model):
    __tablename__ = 'chunk_selection_logs'
    id = db.Column(db.Integer, primary_key=True)
    user_id = db.Column(db.Integer, db.ForeignKey('users.id'), nullable=True)
    instance_id = db.Column(db.String(80), nullable=True)
    episode_index = db.Column(db.Integer, nullable=True)
    recent_messages = db.Column(db.JSON, nullable=False)
    available_chunks = db.Column(db.JSON, nullable=False)
    selected_chunk_index = db.Column(db.Integer, nullable=False)
    created_at = db.Column(db.DateTime, default=get_utc_now)
class MigrationHistory(db.Model):
    __tablename__ = 'migration_history'
    id = db.Column(db.Integer, primary_key=True)
    version = db.Column(db.String(50), unique=True, nullable=False)
    applied_at = db.Column(db.DateTime, default=get_utc_now)
    description = db.Column(db.String(255))

def run_migrations():
    db.create_all()
    # Correctly identify SQLite database dialect natively from SQLAlchemy
    is_sqlite = db.engine.name == 'sqlite'
    pending = [
        ("add_chunk_selection_mode_to_users", "ALTER TABLE users ADD COLUMN chunk_selection_mode VARCHAR(20) DEFAULT 'auto'"),
        ("add_chunk_model_to_users", "ALTER TABLE users ADD COLUMN chunk_model VARCHAR(100)"),
        ("increase_verification_code_length", None if is_sqlite else "ALTER TABLE users ALTER COLUMN verification_code TYPE VARCHAR(256)"),
        ("add_phone_verified_at_to_users", "ALTER TABLE users ADD COLUMN phone_verified_at TIMESTAMP"),
        ("add_free_grant_status_to_users", "ALTER TABLE users ADD COLUMN free_grant_status VARCHAR(50) DEFAULT 'pending_phone'"),
        ("add_free_grant_claimed_at_to_users", "ALTER TABLE users ADD COLUMN free_grant_claimed_at TIMESTAMP"),
        ("add_device_id_hash_to_users", "ALTER TABLE users ADD COLUMN device_id_hash VARCHAR(64)"),
        ("add_signup_ip_hash_to_users", "ALTER TABLE users ADD COLUMN signup_ip_hash VARCHAR(64)"),
        ("add_last_ip_hash_to_users", "ALTER TABLE users ADD COLUMN last_ip_hash VARCHAR(64)"),
        ("add_risk_state_to_users", "ALTER TABLE users ADD COLUMN risk_state VARCHAR(50) DEFAULT 'clear'"),
        ("add_risk_reason_to_users", "ALTER TABLE users ADD COLUMN risk_reason VARCHAR(255)"),
        ("add_generation_locked_until", "ALTER TABLE users ADD COLUMN generation_locked_until TIMESTAMP"),
    ]
    with db.engine.connect() as conn:
        for version, sql in pending:
            exists = MigrationHistory.query.filter_by(version=version).first()
            if exists:
                continue
            if sql is None:
                try:
                    record = MigrationHistory(version=version, description="skipped-incompatible")
                    db.session.add(record)
                    db.session.commit()
                except Exception:
                    db.session.rollback()
                continue
            try:
                conn.execute(db.text(sql))
                conn.commit()
                app_logger.info(f"Migration applied: {version}")
            except Exception as e:
                conn.rollback()
            try:
                record = MigrationHistory(version=version, description=sql[:120])
                db.session.add(record)
                db.session.commit()
            except Exception:
                db.session.rollback()


def initialize_free_tier_rollout():
    changed = False
    users = User.query.filter_by(subscription_tier="Free").all()
    for user in users:
        if user.phone_verified and not user.phone_verified_at and user.phone_number:
            user.phone_verified_at = user.created_at or get_utc_now()
            changed = True
        if user.free_grant_status:
            continue
        if user.phone_verified:
            user.free_grant_status = "verified_existing"
        elif user.is_verified:
            user.free_grant_status = "phone_required_existing"
        elif user.is_verified:
            user.free_grant_status = "ready"
        else:
            user.free_grant_status = "pending_phone"
        changed = True
    if changed:
        db.session.commit()

def check_content_expiration(user) -> dict:
    if not user.content_expires_at:
        return {"status": "infinite", "days_remaining": None, "in_recovery": False}
    now = get_utc_now()
    expires_at = user.content_expires_at
    if expires_at.tzinfo is not None:
        expires_at = expires_at.replace(tzinfo=None)
    days_until_expiry = (expires_at - now).days
    if days_until_expiry > 0:
        return {"status": "active", "days_remaining": days_until_expiry, "in_recovery": False, "expires_at": expires_at.isoformat() + "Z"}
    if user.pending_deletion_at:
        pending_at = user.pending_deletion_at
        if pending_at.tzinfo is not None:
            pending_at = pending_at.replace(tzinfo=None)
        recovery_days = (pending_at - now).days
        if recovery_days > 0:
            return {"status": "recovery", "days_remaining": recovery_days, "in_recovery": True, "expires_at": expires_at.isoformat() + "Z"}
        else:
            return {"status": "expired", "days_remaining": 0, "in_recovery": False, "expires_at": expires_at.isoformat() + "Z"}
    else:
        return {"status": "recovery", "days_remaining": 30, "in_recovery": True, "expires_at": expires_at.isoformat() + "Z"}

def process_content_cleanup():
    now = get_utc_now()
    results = {"warnings_sent": 0, "users_processed": 0, "instances_deleted": 0, "shows_deleted": 0}
    newly_expired = User.query.filter(User.content_expires_at != None, User.content_expires_at <= now, User.pending_deletion_at == None).all()
    for u in newly_expired:
        u.pending_deletion_at = now + timedelta(days=30)
        u.deletion_warning_level = 0
        send_email(u.email, "Cristol: Account Inactive", "Your retention period has ended. Your inactive content is scheduled for deletion in 30 days.")
        results["warnings_sent"] += 1
    db.session.commit()

    pending_users = User.query.filter(User.pending_deletion_at != None, User.pending_deletion_at > now).all()
    for u in pending_users:
        pending_at = u.pending_deletion_at
        if pending_at.tzinfo is not None:
            pending_at = pending_at.replace(tzinfo=None)
        days_left = (pending_at - now).total_seconds() / 86400.0
        if days_left <= 7.0 and u.deletion_warning_level < 1:
            u.deletion_warning_level = 1
            send_email(u.email, "Cristol: URGENT - 7 Days Until Deletion", f"Your inactive content will be permanently deleted in {int(days_left)} days.")
            results["warnings_sent"] += 1
        elif days_left <= 1.0 and u.deletion_warning_level < 2:
            u.deletion_warning_level = 2
            send_email(u.email, "Cristol: CRITICAL - 24 Hours Until Deletion", "Your inactive content will be permanently deleted in less than 24 hours.")
            results["warnings_sent"] += 1

    expired_users = User.query.filter(User.pending_deletion_at != None, User.pending_deletion_at <= now).all()
    results["users_processed"] = len(expired_users)
    for u in expired_users:
        results["instances_deleted"] += InstanceModel.query.filter_by(user_id=u.id).delete()
        results["shows_deleted"] += ShowModel.query.filter_by(user_id=u.id).delete()
        u.pending_deletion_at = None
        u.content_expires_at = None
        u.deletion_warning_level = 0
        send_email(u.email, "Cristol: Content Deleted", "Your retention period ended and your inactive content has been deleted.")
        results["warnings_sent"] += 1
    db.session.commit()
    return results

def restore_user_content(user):
    InstanceModel.query.filter_by(user_id=user.id).update({"marked_for_deletion": False})
    ShowModel.query.filter_by(user_id=user.id).update({"marked_for_deletion": False})
    user.pending_deletion_at = None
    user.deletion_warning_level = 0
    db.session.commit()

def track_event(event_type: str, user_id: int = None, from_tier: str = None, to_tier: str = None, **data):
    try:
        event = AnalyticsEvent(user_id=user_id, event_type=event_type, from_tier=from_tier, to_tier=to_tier, event_data=data if data else None)
        db.session.add(event)
        db.session.commit()
    except Exception:
        pass

def track_signup(user_id, tier, source=None): track_event("signup", user_id=user_id, to_tier=tier, source=source)
def track_login(user_id, tier): track_event("login", user_id=user_id, to_tier=tier)
def track_upgrade(user_id, from_tier, to_tier, billing_cycle=None): track_event("upgrade", user_id=user_id, from_tier=from_tier, to_tier=to_tier, billing_cycle=billing_cycle)
def track_downgrade(user_id, from_tier, to_tier, archived_count=0): track_event("downgrade", user_id=user_id, from_tier=from_tier, to_tier=to_tier, archived_count=archived_count)
def track_credit_usage(user_id, credits_used, credits_remaining, tier): track_event("credit_used", user_id=user_id, to_tier=tier, credits_used=credits_used, credits_remaining=credits_remaining)
def track_trial_day(user_id, day_number): track_event("trial_day", user_id=user_id, day_number=day_number)

def user_is_free_tier_blocked(user) -> bool:
    if user.subscription_tier != "Free":
        return False
    return (user.free_grant_status or "") in {"blocked_reused_phone", "blocked_device_limit"}

def user_requires_phone_verification(user) -> bool:
    if user.subscription_tier != "Free":
        return False
    return not bool(user.phone_verified)

def user_can_use_hosted_credits(user) -> bool:
    if user.risk_state == "blocked":
        return False
    if user.subscription_tier != "Free":
        return True
    if user_is_free_tier_blocked(user):
        return False
    return bool(user.phone_verified)

def ensure_user_rollout_state(user):
    changed = False
    if user.subscription_tier == "Free":
        if user.phone_verified and not user.phone_verified_at and user.phone_number:
            user.phone_verified_at = user.created_at or get_utc_now()
            changed = True
        if not user.free_grant_status:
            if user.phone_verified:
                user.free_grant_status = "verified_existing"
            elif user.is_verified:
                user.free_grant_status = "phone_required_existing"
            else:
                user.free_grant_status = "pending_phone"
            changed = True
        elif user.free_grant_status == "pending_phone" and user.is_verified and not user.phone_verified and user.credits > 0:
            user.free_grant_status = "phone_required_existing"
            changed = True
    elif user.subscription_tier != "Free" and user.free_grant_status == "pending_phone":
        user.free_grant_status = "ready"
        changed = True
    if changed:
        db.session.commit()

def get_user_next_step(user) -> str:
    if user.risk_state == "blocked":
        return "blocked"
    if not user.is_verified:
        return "email_verify"
    if user_is_free_tier_blocked(user):
        return "blocked"
    if user_requires_phone_verification(user):
        return "phone_verify"
    return "ready"

def apply_request_identity(user, *, is_signup=False):
    ip_hash = get_ip_hash()
    device_hash = get_device_hash()
    user.last_ip_hash = ip_hash
    user.device_id_hash = device_hash
    if is_signup:
        user.signup_ip_hash = ip_hash
    return ip_hash, device_hash

def set_auth_cookies(response, user):
    access_token = create_access_token(identity=str(user.id))
    refresh_token = create_refresh_token(identity=str(user.id))
    response_payload = {
        "token": access_token,
        "email": user.email,
        "next_step": get_user_next_step(user),
        "profile": build_user_profile_response(user),
    }
    response.set_data(json_dumps(response_payload))
    response.mimetype = 'application/json'
    set_refresh_cookies(response, refresh_token)
    return response

def auth_response(user, status_code=200):
    ensure_user_rollout_state(user)
    response = make_response('', status_code)
    return set_auth_cookies(response, user)

def failure_counter_key(prefix: str, identifier: str) -> str:
    return f"abuse:{prefix}:{identifier}"

def login_failures_for_ip() -> int:
    return counter_store.get_count(failure_counter_key("login_fail", get_ip_hash()))

def require_turnstile_if_needed(data: dict, *, always: bool = True):
    if not TURNSTILE_SECRET_KEY:
        return None

    turnstile_token = str(data.get('turnstile_token', '')).strip()
    ok, error = verify_turnstile(turnstile_token)
    
    if ok:
        return None
        
    return jsonify({
        "error": error or "Anti-bot verification failed. Please refresh and try again.", 
        "code": "turnstile_required"
    }), 403

def enforce_counter_limit(key: str, limit: int, window: int, *, code: str, message: str):
    count = counter_store.get_count(key)
    ttl = counter_store.get_ttl(key, window)
    if count >= limit and ttl > 0:
        return jsonify({"error": message, "code": code, "retry_after": ttl}), 429
    return None

def hosted_credit_guard(user):
    if user.risk_state == "blocked" or user_is_free_tier_blocked(user):
        return jsonify({
            "error": "This account cannot use hosted free-tier credits. Upgrade to continue.",
            "code": "free_tier_access_blocked",
            "next_step": "blocked",
            "profile": build_user_profile_response(user),
        }), 403
    if user_requires_phone_verification(user):
        return jsonify({
            "error": "Phone verification required before using hosted free-tier credits.",
            "code": "phone_verification_required",
            "next_step": "phone_verify",
            "profile": build_user_profile_response(user),
        }), 403
    return None

def get_effective_api_key_for_user(user):
    if user.risk_state == "blocked" or user_is_free_tier_blocked(user):
        return ""
    if user_requires_phone_verification(user):
        return ""
    return SERVER_API_KEY

def require_admin(f):
    @wraps(f)
    def decorated(*args, **kwargs):
        user = current_user()
        if not user or not user.is_admin:
            return jsonify({"error": "Admin access required"}), 403
        return f(*args, **kwargs)
    return decorated

class RateLimiter:
    def __init__(self):
        self.store = counter_store

    TIER_LIMITS = {
        "Free": {"default": (60, 60), "chat": (15, 60), "auth": (10, 60)},
        "Basic": {"default": (100, 60), "chat": (30, 60), "auth": (10, 60)},
        "Plus": {"default": (200, 60), "chat": (60, 60), "auth": (20, 60)},
        "Pro": {"default": (1000, 60), "chat": (1000, 60), "auth": (30, 60)},
        "anonymous": {"default": (30, 60), "chat": (5, 60), "auth": (10, 60)},
    }

    def is_allowed(self, key, tier, endpoint_type="default"):
        limits = self.TIER_LIMITS.get(tier, self.TIER_LIMITS["anonymous"])
        max_requests, window = limits.get(endpoint_type, limits["default"])
        count, ttl = self.store.increment(key, window)
        if count > max_requests:
            return False, max(ttl, 1)
        return True, max_requests - count

    def get_headers(self, key, tier, endpoint_type="default"):
        limits = self.TIER_LIMITS.get(tier, self.TIER_LIMITS["anonymous"])
        max_requests, window = limits.get(endpoint_type, limits["default"])
        current_count = self.store.get_count(key)
        ttl = self.store.get_ttl(key, window) or window
        remaining = max(0, max_requests - current_count)
        reset_time = int(time.time()) + ttl
        return {"X-RateLimit-Limit": str(max_requests), "X-RateLimit-Remaining": str(remaining), "X-RateLimit-Reset": str(reset_time), "X-RateLimit-Window": str(window)}

rate_limiter = RateLimiter()

class CancellationTracker:
    def __init__(self):
        self.window = 3600
        self.max_cancellations = MAX_CANCELLATIONS_PER_HOUR

    def _get_key(self, user_id):
        return f"abuse:cancellation:{user_id}"

    def can_cancel(self, user_id):
        key = self._get_key(user_id)
        current_count = counter_store.get_count(key)
        remaining = self.max_cancellations - current_count
        if remaining <= 0:
            ttl = counter_store.get_ttl(key, self.window)
            return False, 0, ttl if ttl > 0 else self.window
        return True, remaining, None

    def record_cancellation(self, user_id):
        key = self._get_key(user_id)
        current_count, _ = counter_store.increment(key, self.window)
        if current_count > self.max_cancellations:
            return False, 0
        return True, self.max_cancellations - current_count

    def get_status(self, user_id):
        key = self._get_key(user_id)
        current_count = counter_store.get_count(key)
        remaining = max(0, self.max_cancellations - current_count)
        ttl = counter_store.get_ttl(key, self.window)
        reset_time = None
        if current_count > 0:
            reset_time = int(time.time()) + ttl
        return {
            "cancellations_used": current_count,
            "cancellations_remaining": remaining,
            "max_per_hour": self.max_cancellations,
            "reset_at": reset_time
        }

cancellation_tracker = CancellationTracker()

def current_user_id():
    try:
        raw = get_jwt_identity()
    except RuntimeError:
        return None
    if raw is None:
        return None
    try:
        return int(raw)
    except (TypeError, ValueError):
        return None

def current_user():
    uid = current_user_id()
    if uid is None:
        return None
    return db.session.get(User, uid)

def rate_limit(endpoint_type="default"):
    def decorator(f):
        @wraps(f)
        def decorated_function(*args, **kwargs):
            user = current_user()
            if user:
                key, tier = f"user:{user.id}", user.subscription_tier
            else:
                ip = request.remote_addr or "unknown"
                key, tier = f"ip:{ip}", "anonymous"
            key = f"{key}:{endpoint_type}"
            allowed, value = rate_limiter.is_allowed(key, tier, endpoint_type)
            if not allowed:
                response = jsonify({"error": "Rate limit exceeded", "code": "rate_limited", "retry_after": value, "tier": tier, "upgrade_prompt": tier in["Free", "Basic", "anonymous"]})
                response.status_code = 429
                for header, val in rate_limiter.get_headers(key, tier, endpoint_type).items():
                    response.headers[header] = val
                return response
            rv = f(*args, **kwargs)
            response = make_response(rv)
            for header, val in rate_limiter.get_headers(key, tier, endpoint_type).items():
                response.headers[header] = val
            return response
        return decorated_function
    return decorator

DEFAULT_SYSTEM_PROMPT = """
You are a collaborative fiction author. Your role is to bring a story to life around the user's original character (OC), adapting events from the transcript so they are genuinely present in the narrative — not watching it from the sidelines.

PROSE & VOICE
Write in immersive, literary second-person ("you"). Paragraph form only — no bullet points, headers, numbered lists, or bracketed stage directions. Show emotion through action and word choice. Vary sentence rhythm. Let silence carry weight. Write at the speed the scene demands, not the speed of the plot.

THE ONE ABSOLUTE RULE: YOU NEVER CONTROL THE USER'S CHARACTER.
You do not write their dialogue, decisions, internal feelings, or physical actions. You write the world around them — other characters, consequences, atmosphere, pressure — and then you stop. Never have them nod, agree, speak, or move unless the user has written it themselves. If the scene demands a reaction from them, write to that moment and pause.

THE TRANSCRIPT IS SOURCE MATERIAL, NOT A SCRIPT
Treat it like a screenwriter treats a novel — the beats, locations, characters, and arc are yours to use, but you adapt them so the user's character is woven into every scene. Every line in the current transcript chunk must be dramatized. You may not skip, compress, or fast-forward any moment to reach later content. If a character says something, that line happens. If a scene occurs, you play it out. Skipping is a critical failure.

When a transcript scene involves a group, pull the user's character in. Have someone address them directly. Force a choice. Let their presence change something. The story happens to them, not in front of them.

MAIN PLOT GRAVITY — EVERY RESPONSE
The main plot thread is always active. Every response — regardless of what the user is doing — must contain at least one element keeping it present: a distant sound, a character checking the time, a piece of news arriving at the edge of the scene. This is never announced. It simply happens, the way life continues around a distracted person.

PAUSE POINTS
End your passage and hand control back at any moment where:
— Another character asks a direct question or waits for an answer.
— A decision only the user's character can make is reached.
— The user's character enters a scene and others are registering them.
— A confrontation reaches the moment their response determines what happens next.
— They are offered something — alliance, threat, object, information.

Write to the pause point. Do not resolve it. Stop. The user fills what comes next.

If the user provides no action and only asks to continue, advance only to the next pause point and stop there. Never write past the point where their input runs out.

REACTING TO USER INPUT
Treat everything the user writes as canon. React honestly — bravery is noticed, recklessness has consequences, kindness softens the room. After their action lands, continue weaving back toward the transcript's arc at a natural pace. Never rush back at the expense of what just happened.

CHARACTERS & WORLD
You own every character except the user's. Give them consistent interiority — unspoken motivations, human contradictions, history. Let them evolve based on what the user actually does. The world does not reset. Characters remember prior choices, wounds, and shifts in relationship. If the user's character profile or lore establishes something as true, it stays true unless the story explicitly changes it.

Match the tone of the material. Don't soften conflict the transcript calls for. Don't inject gratuitous content a scene doesn't need.

SCENE COMPLETION TAG
When you have successfully dramatized ALL the events in the [Current scene] block, and there is nothing left in the current chunk to adapt, you MUST append the exact tag [CHUNK_COMPLETE] at the very end of your response. Do not use this tag if you are pausing for a user choice but haven't finished the current scene's material yet.
"""



DEFAULT_SUMMARY_PROMPT = """
You are a continuity editor for interactive second-person fiction. Write a dense, past-tense briefing of this session. This summary will be fed directly back to the AI to resume the story, so it must contain exact, usable data.

REQUIRED FIELDS (weave into prose, no headers):
1. PROTAGONIST STATE: Current physical condition, injuries, gear, and immediate emotional state.
2. RELATIONSHIP LEDGER: For every character interacted with, note their exact disposition toward the protagonist (e.g., wary, indebted, furious) and any specific promises, debts, or betrayals.
3. CONSEQUENCES: What did the protagonist do, and what was the exact immediate result? Include the "why."
4. PLOT POSITION: Exact current location, time of day, and the immediate ticking clock or pressure forcing the next move.
5. WORLD STATE: Items gained/lost, secrets learned, locations unlocked.

STYLE RULES:
- Past tense, second person ("You did X").
- Ruthlessly specific with names, places, and outcomes.
- Capture the emotional temperature of the room.
- No generic filler. "You had a conversation" is useless. "You lied to Marcus about the missing key, and he believed you, but Sarah noticed" is perfect.
- Maximum 400 words.
"""



def require_current_user():
    user = current_user()
    if not user:
        return None
    return user

def require_credits(amount=1.0):
    def decorator(f):
        @wraps(f)
        def decorated_function(*args, **kwargs):
            user = current_user()
            if not user:
                return jsonify({"error": "User not found"}), 404
            if user.should_reset_credits():
                user.reset_credits()
                db.session.commit()
            if user.credits < float(amount):
                return jsonify({"error": "Insufficient credits", "code": "insufficient_credits", "credits_remaining": math.floor(user.credits), "credits_required": amount, "upgrade_prompt": True}), 402
            return f(*args, **kwargs)
        return decorated_function
    return decorator

email_thread_pool = concurrent.futures.ThreadPoolExecutor(max_workers=2)

def send_email_async(to_email, subject, body, html_body=None):
    if not SMTP_USER or not SMTP_PASS:
        return True
    try:
        if html_body:
            msg = MIMEMultipart('alternative')
            msg['Subject'] = subject
            msg['From'] = SMTP_USER
            msg['To'] = to_email
            
            msg.attach(MIMEText(body, 'plain', 'utf-8'))
            msg.attach(MIMEText(html_body, 'html', 'utf-8'))
        else:
            msg = MIMEText(body, 'plain', 'utf-8')
            msg['Subject'] = subject
            msg['From'] = SMTP_USER
            msg['To'] = to_email

        if SMTP_PORT == 465:
            with smtplib.SMTP_SSL(SMTP_SERVER, SMTP_PORT, timeout=15) as server:
                server.login(SMTP_USER, SMTP_PASS)
                server.send_message(msg)
        else:
            with smtplib.SMTP(SMTP_SERVER, SMTP_PORT, timeout=15) as server:
                server.ehlo()
                server.starttls()
                server.ehlo()
                server.login(SMTP_USER, SMTP_PASS)
                server.send_message(msg)
        return True
    except Exception as e:
        app_logger.error(f"Email send failed: {e}", exc_info=True)
        return False

def send_email(to_email, subject, body, html_body=None):
    if not SMTP_USER or not SMTP_PASS:
        return True
    email_thread_pool.submit(send_email_async, to_email, subject, body, html_body=html_body)
    return True

def generate_and_send_otp(user):
    code = str(secrets.randbelow(900000) + 100000)
    user.verification_code = generate_password_hash(code)
    user.verification_sent_at = get_utc_now()
    db.session.commit()

    if not SMTP_USER or not SMTP_PASS:
        return True, None

    plain_body = f"Your Cristol verification code is: {code}\nThis code will expire in 10 minutes.\nIf you did not request this, please ignore this email."
    
    html_body = f"""
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8">
      <style>
        @import url('https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@700&display=swap');
      </style>
    </head>
    <body style="background-color: #f9f9f9; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; color: #333333; padding: 40px 20px; margin: 0;">
      <table width="100%" cellpadding="0" cellspacing="0" style="max-width: 600px; margin: 0 auto; background-color: #ffffff; border: 1px solid #e0e0e0; border-radius: 8px; border-collapse: collapse;">
        <tr>
          <td style="padding: 30px; text-align: center; border-bottom: 1px solid #e0e0e0; background-color: #1a1a1a; border-radius: 8px 8px 0 0;">
            <div style="font-size: 24px; font-weight: 700; letter-spacing: 0.2em; color: #ffffff; font-family: 'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', monospace;">◈ CRISTOL</div>
          </td>
        </tr>
        <tr>
          <td style="padding: 40px 30px; text-align: center;">
            <div style="font-size: 12px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.1em; color: #888888; margin-bottom: 20px;">
              Verification Required
            </div>
            <p style="font-size: 16px; margin-bottom: 30px; line-height: 1.5; color: #444444;">
              Please use the authorization code below to complete your sign-in attempt.
            </p>
            <div style="font-size: 32px; font-weight: 700; letter-spacing: 0.2em; color: #1a1a1a; background: #f0f0f0; padding: 20px; display: inline-block; margin-bottom: 30px; border-radius: 6px; border: 1px solid #dddddd;">
              {code}
            </div>
            <p style="font-size: 13px; color: #888888; line-height: 1.5;">
              This code will expire in 10 minutes.<br>If you did not request this, you can safely ignore this email.
            </p>
          </td>
        </tr>
      </table>
    </body>
    </html>
    """

    send_email(user.email, "Cristol Verification Code", plain_body, html_body=html_body)
    return True, None

def parse_json_body():
    data = request.get_json(force=True, silent=True)
    if not isinstance(data, dict):
        return {}
    return data

def save_model_data(model_obj):
    flag_modified(model_obj, "data")
    db.session.commit()

def load_instance_or_404(inst_id, user_id):
    return InstanceModel.query.filter_by(id=inst_id, user_id=user_id).first_or_404()

def get_headers(api_key):
    return {"Authorization": f"Bearer {api_key}", "Content-Type": "application/json", "HTTP-Referer": APP_BASE_URL, "X-Title": "Cristol"}

def get_prompt_hash(prompt_messages):
    clean_msgs =[{"role": m.get("role"), "content": m.get("content")} for m in prompt_messages]
    s = json.dumps(clean_msgs, sort_keys=True)
    return hashlib.sha256(s.encode('utf-8')).hexdigest()

def update_finetuning_edits(changed_hashes):
    if not env_flag('ENABLE_FINETUNING_LOGS', False):
        return
    if not changed_hashes:
        return
        
    try:
        logs = FinetuningLog.query.filter(FinetuningLog.prompt_hash.in_(changed_hashes.keys())).all()
        for log_entry in logs:
            new_content = changed_hashes[log_entry.prompt_hash]
            msgs = list(log_entry.messages)
            if msgs and msgs[-1].get("role") == "assistant":
                msgs[-1]["content"] = new_content
                log_entry.messages = msgs
                flag_modified(log_entry, "messages")
        db.session.commit()
    except Exception as e:
        db.session.rollback()
        app_logger.error(f"Error updating finetuning edits in DB: {e}")

def log_finetuning_data(prompt_messages, assistant_text, prompt_hash):
    if not env_flag('ENABLE_FINETUNING_LOGS', False):
        return
    try:
        clean_msgs = [{"role": m.get("role"), "content": m.get("content")} for m in prompt_messages]
        final_messages = clean_msgs + [{"role": "assistant", "content": assistant_text}]
        
        existing_log = FinetuningLog.query.filter_by(prompt_hash=prompt_hash).first()
        if existing_log:
            existing_log.messages = final_messages
            flag_modified(existing_log, "messages")
        else:
            new_log = FinetuningLog(prompt_hash=prompt_hash, messages=final_messages)
            db.session.add(new_log)
        db.session.commit()
    except Exception as e:
        db.session.rollback()
        app_logger.error(f"Finetuning DB log error: {e}")

def get_generation_cost(generation_id, api_key, max_retries=3, initial_delay=0.5):
    if not generation_id or not api_key:
        return {"success": False, "error": "Missing generation_id or api_key", "total_cost": 0.0}
    for attempt in range(max_retries):
        try:
            resp = requests_session.get(f"{OPENROUTER_API_URL}/generation?id={generation_id}", headers={"Authorization": f"Bearer {api_key}"}, timeout=5)
            if resp.status_code == 200:
                data = resp.json()
                gen_data = data.get("data", {})
                return {"success": True, "total_cost": float(gen_data.get("total_cost", 0) or 0), "native_tokens_prompt": int(gen_data.get("native_tokens_prompt", 0) or 0), "native_tokens_completion": int(gen_data.get("native_tokens_completion", 0) or 0), "tokens_prompt": int(gen_data.get("tokens_prompt", 0) or 0), "tokens_completion": int(gen_data.get("tokens_completion", 0) or 0), "generation_time": float(gen_data.get("generation_time", 0) or 0), "model": gen_data.get("model", ""), "provider": gen_data.get("provider_name", "")}
            elif resp.status_code == 404:
                if attempt < max_retries - 1:
                    time.sleep(0.3 * (attempt + 1))
                    continue
                return {"success": False, "error": "Generation not found after retries", "total_cost": 0.0}
            else:
                return {"success": False, "error": f"API returned {resp.status_code}", "total_cost": 0.0}
        except requests.exceptions.Timeout:
            if attempt < max_retries - 1:
                time.sleep(0.3)
                continue
            return {"success": False, "error": "Request timeout", "total_cost": 0.0}
        except Exception as e:
            return {"success": False, "error": str(e), "total_cost": 0.0}
    return {"success": False, "error": "Max retries exceeded", "total_cost": 0.0}

def usd_to_credits(usd_amount):
    return round(usd_amount / CREDIT_CONVERSION_RATE, 4)

def call_model(messages, model, api_key, max_tokens=2048, temperature=0.3, priority=False):
    if not api_key:
        return None, "No API key", 0.0
    try:
        headers = get_headers(api_key)
        if priority:
            headers["X-Priority"] = "high"
        payload = {"model": model, "messages": messages, "temperature": temperature, "max_tokens": max_tokens, "stream": False, "include_reasoning": True}
        resp = requests_session.post(f"{OPENROUTER_API_URL}/chat/completions", headers=headers, json=payload, timeout=30 if not priority else 45)
        if resp.status_code == 200:
            data = resp.json()
            if 'error' in data:
                return None, data['error'].get('message', 'Unknown error'), 0.0
            generation_id = data.get('id')
            content = data['choices'][0]['message']['content']
            cost_usd = 0.0
            if generation_id:
                cost_info = get_generation_cost(generation_id, api_key)
                if cost_info["success"]:
                    cost_usd = cost_info["total_cost"]
                else:
                    cost_usd = float(data.get('usage', {}).get('cost', 0) or 0)
            return content, None, cost_usd
        return None, f"API returned {resp.status_code}", 0.0
    except Exception as e:
        err_msg = str(e).replace(api_key, "***KEY_HIDDEN***") if api_key else str(e)
        return None, err_msg, 0.0

def stream_openrouter(messages, model, api_key, priority=False):
    effective_key = api_key or SERVER_API_KEY
    if not effective_key:
        yield "[Error: OPENROUTER_API_KEY not set in .env]"
        return
    try:
        headers = get_headers(effective_key)
        if priority:
            headers["X-Priority"] = "high"
        payload = {"model": model, "messages": messages, "stream": True, "max_tokens": 2048, "temperature": 1, "top_p": 0.95, "include_reasoning": True}
        generation_id_sent = False
        with requests_session.post(f"{OPENROUTER_API_URL}/chat/completions", headers=headers, json=payload, stream=True, timeout=120 if not priority else 180) as resp:
            if resp.status_code >= 400:
                yield f"[Error: API returned {resp.status_code}]"
                return
            for line in resp.iter_lines():
                if not line:
                    continue
                decoded = line.decode('utf-8', errors='ignore')
                if not decoded.startswith('data: '):
                    continue
                data_str = decoded[6:].strip()
                if data_str == '[DONE]':
                    break
                try:
                    data = json.loads(data_str)
                except json.JSONDecodeError:
                    continue
                if 'error' in data:
                    yield f"[Error: {data['error'].get('message', 'Unknown')}]"
                    return
                if not generation_id_sent and 'id' in data:
                    yield {"__generation_id__": data['id']}
                    generation_id_sent = True
                usage = data.get('usage', {})
                if usage:
                    stream_cost = usage.get('cost') or usage.get('total_cost')
                    if stream_cost is not None:
                        yield {"__stream_cost__": float(stream_cost)}
                choices = data.get('choices',[])
                if not choices:
                    continue
                delta = choices[0].get('delta', {})
                reasoning = delta.get('reasoning') or delta.get('reasoning_content')
                token = delta.get('content')
                if reasoning:
                    yield {"__reasoning__": reasoning}
                if token:
                    yield token
    except Exception as e:
        err_msg = str(e).replace(effective_key, "***KEY_HIDDEN***") if effective_key else str(e)
        if "Connection" in err_msg or "Timeout" in err_msg:
            yield f"[Error: Network connection to AI provider dropped ({type(e).__name__})]"
        else:
            yield f"[Error: {err_msg}]"

def call_summary_api(transcript_text, user, auto=True):
    config = user.get_effective_tier_config()
    if not config.get("auto_summaries") and auto:
        return ("[Automatic summaries require Plus or higher. Please write your summary manually.]", 0.0)
    api_key = get_effective_api_key_for_user(user)
    if not api_key:
        return "•[Summary unavailable: Add your own API key or verify your phone number]", 0.0
    summary_model = user.summary_model or DEFAULT_SUMMARIZATION_MODEL
    summary_prompt = DEFAULT_SUMMARY_PROMPT
    messages =[
        {"role": "system", "content": summary_prompt},
        {"role": "user", "content": f"Summarize this session:\n{transcript_text}"},
    ]
    priority = config.get("priority_processing", False)
    result, error, cost = call_model(messages, summary_model, api_key, max_tokens=2048, temperature=0.3, priority=priority)
    if error:
        return f"• Summary generation failed: {error}", 0.0
    return result, cost



def build_user_profile_response(user):
    ensure_user_rollout_state(user)
    config = user.get_effective_tier_config()
    trial_finished_today = False
    if user.subscription_tier == "Basic" and user.plus_trial_days_used >= 3:
        today = get_utc_now().date()
        if user.plus_trial_last_active_date == today:
            trial_finished_today = True
    cancel_status = cancellation_tracker.get_status(user.id)
    return {
        "id": user.id, "email": user.email,
        "created_at": (user.created_at.isoformat() + "Z" if user.created_at else None),
        "is_verified": user.is_verified,
        "credits": math.floor(user.credits),
        "credits_total": math.floor(user.get_display_credit_total()),
        "credits_reset_at": (user.credits_reset_at.isoformat() + "Z" if user.credits_reset_at else None),
        "subscription_tier": user.subscription_tier,
        "subscription_started_at": (user.subscription_started_at.isoformat() + "Z" if user.subscription_started_at else None),
        "subscription_ends_at": (user.subscription_ends_at.isoformat() + "Z" if user.subscription_ends_at else None),
        "billing_cycle": user.billing_cycle or 'monthly',
        "credit_addon": user.credit_addon,
        "phone_verified": bool(user.phone_verified),
        "masked_phone": mask_phone_number(user.phone_number),
        "free_grant_status": user.free_grant_status or None,
        "can_use_hosted_credits": user_can_use_hosted_credits(user),
        "next_step": get_user_next_step(user),
        "is_in_plus_trial": user.is_in_plus_trial(),
        "plus_trial_days_remaining": (max(0, 3 - user.plus_trial_days_used) if user.subscription_tier == "Basic" else 0),
        "plus_trial_days_used": (user.plus_trial_days_used if user.subscription_tier == "Basic" else 0),
        "trial_finished_today": trial_finished_today,
        "trial_finished_message": ("Your Plus trial has ended." if trial_finished_today else None),
        "content_expires_at": (user.content_expires_at.isoformat() + "Z" if user.content_expires_at else None),
        "pending_deletion_at": (user.pending_deletion_at.isoformat() + "Z" if user.pending_deletion_at else None),
        "is_admin": user.is_admin,
        "tier_config": config,
        "cancellation_status": cancel_status,
        "chunk_selection_mode": user.chunk_selection_mode or "auto",
        "chunk_model": user.chunk_model or DEFAULT_SUMMARIZATION_MODEL,
    }

_SENTENCE_END_RE = re.compile(r'(?<=[.!?]["\'\u2019\u201d])\s+|(?<=[.!?])\s+(?=[A-Z"\'\u2019\u201d])')
_SCENE_HEADER_RE = re.compile(r'^(?:SCENE|CUT\s+TO|INT\.|EXT\.)', re.IGNORECASE)
_ABBREV_RE = re.compile(r'\b(Mr|Mrs|Ms|Dr|Prof|St|vs|etc|approx|dept|govt|inc|corp|ltd|co)\.', re.IGNORECASE)

def _split_into_sentences(text: str) -> list:
    protected = _ABBREV_RE.sub(lambda m: m.group(0)[:-1] + '\x00', text)
    raw_parts = _SENTENCE_END_RE.split(protected)
    sentences =[]
    for part in raw_parts:
        restored = part.replace('\x00', '.')
        stripped = restored.strip()
        if stripped:
            sentences.append(stripped)
    return sentences

def split_transcript_into_chunks(transcript_text: str, max_chars: int = 2400) -> list:
    if not transcript_text:
        return []
    paragraphs =[p.strip() for p in transcript_text.split('\n\n') if p.strip()]
    if not paragraphs:
        return [transcript_text.strip()] if transcript_text.strip() else []
    chunks =[]
    current_parts =[]
    current_len = 0
    def flush():
        nonlocal current_parts, current_len
        if not current_parts:
            return
        block = ' '.join(current_parts)
        if block:
            chunks.append(block)
        current_parts =[]
        current_len = 0
    for paragraph in paragraphs:
        if _SCENE_HEADER_RE.match(paragraph):
            flush()
            chunks.append(paragraph)
            continue
        sentences = _split_into_sentences(paragraph)
        if not sentences:
            sentences = [paragraph]
        for sentence in sentences:
            sentence_len = len(sentence) + 1
            if not current_parts and sentence_len > max_chars:
                flush()
                chunks.append(sentence)
                continue
            if current_parts and current_len + sentence_len > max_chars:
                flush()
            current_parts.append(sentence)
            current_len += sentence_len
    flush()
    return[c for c in chunks if c.strip()]

def get_chunk_preview(chunk, max_length=100):
    lines =[line.strip() for line in chunk.split('\n') if line.strip()]
    if not lines:
        return chunk[:max_length]
    preview = " ".join(lines[:3])[:max_length]
    if len(" ".join(lines[:3])) > max_length:
        preview += "..."
    return preview

def get_windowed_chunk(chunks: list, index: int,
                       prev_sentences: int = SLIDING_WINDOW_PREV_SENTENCES,
                       next_sentences: int = SLIDING_WINDOW_NEXT_SENTENCES) -> str:
    if not chunks or index < 0 or index >= len(chunks):
        return ""
    parts = []
    if index > 0 and prev_sentences > 0:
        prev_sents = _split_into_sentences(chunks[index - 1])[-prev_sentences:]
        if prev_sents:
            parts.append(
                f"[Previous scene — for continuity only, do not re-dramatize]\n"
                f"{' '.join(prev_sents)}"
            )
    parts.append(f"[Current scene — dramatize fully]\n{chunks[index]}")
    if index < len(chunks) - 1 and next_sentences > 0:
        next_sents = _split_into_sentences(chunks[index + 1])[:next_sentences]
        if next_sents:
            parts.append(
                f"[Upcoming — do not advance to this yet]\n"
                f"{' '.join(next_sents)}"
            )
    return "\n\n".join(parts)



def record_chunk_played(instance_data, episode_index, chunk_index, chunks, user):
    if not chunks or chunk_index < 0 or chunk_index >= len(chunks):
        return
    played_segments = instance_data.setdefault('played_segments',[])
    if chunk_index not in played_segments:
        played_segments.append(chunk_index)
    instance_data['current_chunk_id'] = chunk_index
    progress = instance_data.setdefault('transcript_progress', {})
    progress['episodeIndex'] = episode_index
    progress['chunkIndex'] = chunk_index

def update_rolling_summary(instance_data, user, history_budget=MAX_HISTORY_TOKENS):
    if not user.get_effective_tier_config().get("auto_summaries"):
        return 0.0

    messages = instance_data.get('messages', [])
    if len(messages) <= 2:
        return 0.0

    history_tokens = sum(estimate_tokens(m.get('content', '')) for m in messages)
    
    if len(messages) <= MAX_RECENT_MESSAGES and history_tokens <= history_budget:
        return 0.0

    keep_count = 2
    used_tokens = sum(estimate_tokens(m.get('content', '')) for m in messages[-2:])
    
    for i in range(3, len(messages) + 1):
        if keep_count >= MAX_RECENT_MESSAGES:
            break
        msg_tokens = estimate_tokens(messages[-i].get('content', ''))
        if used_tokens + msg_tokens > history_budget:
            break
        used_tokens += msg_tokens
        keep_count += 1

    if keep_count >= len(messages):
        return 0.0

    recent_messages = messages[-keep_count:]
    older_messages = messages[:-keep_count]

    old_transcript = "\n".join([
        f"{'USER' if m.get('role') == 'user' else 'STORY'}: {m.get('content', '')[:700]}"
        for m in older_messages[-MAX_HISTORY_BEFORE_SUMMARY:]
    ]).strip()

    previous_summary = instance_data.get('rollingSummary', '').strip()

    if previous_summary:
        summary_prompt = (
            f"Current story briefing (keep and update this):\n{previous_summary}\n\n"
            f"New events to incorporate:\n{old_transcript}\n\n"
            "Merge ONLY important new information into the briefing. "
            "Update the protagonist's physical/emotional state, relationship ledgers, "
            "and exact plot position. Remove resolved threads. "
            "Past tense, second person. Specific names and outcomes. No filler. "
            f"Maximum {MAX_SUMMARY_WORDS} words."
        )
    else:
        summary_prompt = (
            f"Write a continuity briefing of these events:\n{old_transcript}\n\n"
            "Cover: protagonist state, relationship shifts with exact dispositions, "
            "consequences of choices, exact plot position/ticking clock, and world state changes. "
            "Past tense, second person. Specific names and outcomes. No filler. "
            f"Maximum {MAX_SUMMARY_WORDS} words."
        )

    summary, cost = call_summary_api(summary_prompt, user, auto=True)

    if summary and not summary.startswith("•[Summary unavailable"):
        clean_summary = summary.strip()[:MAX_SUMMARY_WORDS * 6]
        instance_data['rollingSummary'] = clean_summary
        instance_data['rollingSummaryCount'] = instance_data.get('rollingSummaryCount', 0) + len(older_messages)

    return cost

def get_episode_context(instance_data):
    ep_idx = instance_data.get('currentEpisodeIndex', 0)
    episodes = instance_data.get('episodes',[])
    ep_name = f"Episode {ep_idx + 1}"
    ep_text = ""
    if ep_idx < len(episodes):
        current_ep = episodes[ep_idx]
        ep_name = current_ep.get('name', ep_name)
        ep_text = current_ep.get('context', '').strip()
    return ep_idx, ep_name, ep_text

def get_episode_chunks(instance_data):
    ep_idx, ep_name, ep_text = get_episode_context(instance_data)
    chunks = split_transcript_into_chunks(ep_text)
    return ep_idx, ep_name, ep_text, chunks

def _build_system_message(
    base_system: str,
    lore: str,
    profile: str,
    rolling_summary: str,
    story_context: str,
) -> tuple:
    sacred_tokens = (
        estimate_tokens(base_system) + 
        estimate_tokens(story_context) + 
        estimate_tokens(lore) + 
        estimate_tokens(profile)
    )
    
    budget_for_summary = MAX_SYSTEM_TOKENS - sacred_tokens
    summary_tokens = estimate_tokens(rolling_summary)
    
    summary_overflow = 0
    if summary_tokens > budget_for_summary:
        summary_overflow = summary_tokens - max(0, budget_for_summary)
        
    parts = [base_system]
    if lore:
        parts.append(f"<world_lore>\n{lore}\n</world_lore>")
    if profile:
        parts.append(f"<user_character>\n{profile}\n</user_character>")
    if rolling_summary:
        parts.append(f"<story_so_far>\n{rolling_summary}\n</story_so_far>")
    if story_context:
        parts.append(f"<current_scene>\n{story_context}\n</current_scene>")
 
    return "\n\n".join(parts), summary_overflow
 
def _select_history_messages(conv_messages: list, history_token_budget: int) -> list:
    if not conv_messages:
        return []
        
    selected: list = []
    used = 0
    protected_count = 0
    
    for msg in reversed(conv_messages):
        # SECURITY PATCH: Hard cap individual historical messages to prevent token bloat
        content = msg.get('content', '')
        if estimate_tokens(content) > 4000:
            msg['content'] = _trim_to_tokens(content, 4000)
            
        t = estimate_tokens(msg.get('content', ''))
        
        if protected_count < 2:
            selected.insert(0, msg)
            used += t
            protected_count += 1
        else:
            if used + t > history_token_budget:
                break
            selected.insert(0, msg)
            used += t
            
    return selected

def build_prompt_chain(instance_data, user, target_model=None, chunk_mode=None):
    if chunk_mode is None:
        chunk_mode = user.chunk_selection_mode or "auto"
 
    lore            = instance_data.get('lore', '').strip()
    profile         = instance_data.get('profile', '').strip()
 
    ep_idx, ep_name, ep_text, chunks = get_episode_chunks(instance_data)
 
    conv_messages = instance_data.get('messages', [])
    last_user_msg = ""
    if conv_messages and conv_messages[-1].get('role') == 'user':
        last_user_msg = conv_messages[-1].get('content', '').strip()
 
    current = instance_data.get('current_chunk_id', 0)
    selected_chunk_id = max(0, min(current, len(chunks) - 1)) if chunks else 0
    selection_reason = "sequential"
    if selected_chunk_id is not None:
        instance_data['current_chunk_id'] = selected_chunk_id

    story_context_parts = []
    if selected_chunk_id == 0:
        summaries = instance_data.get('summaryHistory', [])
        if summaries:
            ep_summary = summaries[-1].get('summary', '')
            ep_title   = summaries[-1].get('episodeName', 'Previous Episode')
            story_context_parts.append(f"**{ep_title} Summary:**\n{ep_summary}")
    if chunks and selected_chunk_id is not None:
        story_context_parts.append(get_windowed_chunk(chunks, selected_chunk_id))
 
    story_context_str = "\n\n".join(story_context_parts)
    
    sacred_tokens = (
        estimate_tokens(DEFAULT_SYSTEM_PROMPT) + 
        estimate_tokens(story_context_str) + 
        estimate_tokens(lore) + 
        estimate_tokens(profile)
    )
    
    current_summary = instance_data.get('rollingSummary', '').strip()
    summary_tokens = estimate_tokens(current_summary)
    budget_for_summary = MAX_SYSTEM_TOKENS - sacred_tokens
    summary_overflow = max(0, summary_tokens - max(0, budget_for_summary))
    
    base_history_budget = max(0, MAX_HISTORY_TOKENS - summary_overflow)
    hard_limit_history_budget = max(0, MAX_TOTAL_TOKENS - sacred_tokens - summary_tokens)
    
    true_history_budget = min(base_history_budget, hard_limit_history_budget)
    
    pre_flight_cost = update_rolling_summary(instance_data, user, true_history_budget)
    
    rolling_summary = instance_data.get('rollingSummary', '').strip()
    conv_messages = instance_data.get('messages', [])
 
    assembled_system, summary_overflow_tokens = _build_system_message(
        base_system     = DEFAULT_SYSTEM_PROMPT,
        lore            = lore,
        profile         = profile,
        rolling_summary = rolling_summary,
        story_context   = story_context_str,
    )
 
    history_budget    = max(0, MAX_HISTORY_TOKENS - summary_overflow_tokens)
    recent_for_prompt = _select_history_messages(conv_messages, history_budget)
 
    total_tokens = estimate_tokens(assembled_system) + sum(
        estimate_tokens(m.get('content', '')) for m in recent_for_prompt
    )
    if total_tokens > MAX_TOTAL_TOKENS:
        emergency_budget = max(0, MAX_TOTAL_TOKENS - estimate_tokens(assembled_system))
        recent_for_prompt = _select_history_messages(recent_for_prompt, emergency_budget)
        
        recalculated_total = estimate_tokens(assembled_system) + sum(
            estimate_tokens(m.get('content', '')) for m in recent_for_prompt
        )
        if recalculated_total > MAX_TOTAL_TOKENS:
            compression_prompt = (
                f"Compress the following story briefing into a highly dense, strictly factual summary under {MAX_SUMMARY_WORDS} words. "
                "Keep protagonist state, relationships, consequences, and exact plot position. No filler.\n\n"
                f"{rolling_summary}"
            )
            
            compressed_summary, compression_cost = call_summary_api(compression_prompt, user, auto=True)
            
            if compressed_summary and not compressed_summary.startswith("•[Summary unavailable"):
                rolling_summary = compressed_summary.strip()
                instance_data['rollingSummary'] = rolling_summary
                pre_flight_cost += compression_cost
                
            assembled_system, _ = _build_system_message(
                DEFAULT_SYSTEM_PROMPT, lore, profile, rolling_summary, story_context_str
            )
            
            final_total = estimate_tokens(assembled_system) + sum(estimate_tokens(m.get('content', '')) for m in recent_for_prompt)
            if final_total > MAX_TOTAL_TOKENS:
                protected_history_tokens = sum(estimate_tokens(m.get('content', '')) for m in recent_for_prompt)
                absolute_max_summary = max(0, MAX_TOTAL_TOKENS - (sacred_tokens + protected_history_tokens))
                shrunk_summary = _trim_to_tokens(rolling_summary, absolute_max_summary) if absolute_max_summary > 0 else ""
                assembled_system, _ = _build_system_message(
                DEFAULT_SYSTEM_PROMPT, lore, profile, shrunk_summary, story_context_str
            )

    messages = [{"role": "system", "content": assembled_system}]


    messages = [{"role": "system", "content": assembled_system}]
    for msg in recent_for_prompt:
        content = msg.get('content', '').strip()
        if not content:
            continue
        role = 'assistant' if msg.get('role') in {'assistant', 'ai'} else 'user'
        messages.append({"role": role, "content": content})
 
    chunk_index_for_meta = selected_chunk_id if selected_chunk_id is not None else 0
 
    return messages, {
        "episodeIndex":    ep_idx,
        "episodeName":     ep_name,
        "chunkIndex":      chunk_index_for_meta,
        "chunkCount":      len(chunks),
        "mode":            chunk_mode,
        "selectionReason": selection_reason,
        "preFlightCost":   pre_flight_cost,
    }

@app.route('/api/auth/register', methods=['POST'])
@rate_limit("auth")
def register():
    data = parse_json_body()
    email_val = data.get('email')
    email = str(email_val).strip().lower() if email_val is not None else ''
    password_val = data.get('password')
    password = str(password_val) if password_val is not None else ''
    tos_accepted = data.get('tos_accepted', False)

    ip_limit = enforce_counter_limit(
        failure_counter_key("register_ip", get_ip_hash()), 20, 60 * 60,
        code="register_ip_limited",
        message="Too many sign-up attempts from this IP."
    )
    if ip_limit:
        return ip_limit
    device_limit = enforce_counter_limit(
        failure_counter_key("register_device", get_device_hash()), 5, 24 * 60 * 60,
        code="register_device_limited",
        message="Too many sign-up attempts from this device."
    )
    if device_limit:
        return device_limit

    ok, turnstile_error = verify_turnstile(str(data.get('turnstile_token', '')).strip())
    if not ok:
        return jsonify({"error": turnstile_error or "Turnstile verification failed", "code": "turnstile_required"}), 403
    if not email or not password:
        return jsonify({"error": "Email and password required"}), 400
    if len(password) < 6:
        return jsonify({"error": "Password must be at least 6 characters"}), 400
    if is_disposable_email(email):
        return jsonify({"error": "Disposable email addresses are not allowed.", "code": "disposable_email_blocked"}), 400
    if not tos_accepted:
        return jsonify({"error": "You must accept the Terms of Service to register."}), 400

    user = User.query.filter_by(email=email).first()
    created = False
    if user:
        if user.is_verified:
            if not user.password_hash:
                return jsonify({"error": "Account was created via Google. Please log in with Google."}), 400
            return jsonify({"error": "Email already registered"}), 400
        user.password_hash = generate_password_hash(password)
    else:
        user = User(
            email=email,
            password_hash=generate_password_hash(password),
            is_verified=False,
            subscription_tier="Free",
            credits=0.0,
            phone_verified=False,
            free_grant_status="pending_phone",
        )
        apply_request_identity(user, is_signup=True)
        db.session.add(user)
        db.session.flush()
        created = True

    success, error = generate_and_send_otp(user)
    if not success:
        return jsonify({"error": f"Email failed: {error}"}), 500

    if created:
        counter_store.increment(failure_counter_key("register_ip", get_ip_hash()), 60 * 60)
        counter_store.increment(failure_counter_key("register_device", get_device_hash()), 24 * 60 * 60)
        track_signup(user.id, "Free", source="email")

    return jsonify({"message": "Verification code sent", "require_verification": True, "next_step": "email_verify"})

@app.route('/api/auth/resend-code', methods=['POST'])
@rate_limit("auth")
def resend_code():
    data = parse_json_body()
    email = str(data.get('email', '')).strip().lower()
    if not email:
        return jsonify({"error": "Email required"}), 400

    user = User.query.filter_by(email=email).first()
    if not user:
        return jsonify({"message": "If a matching account exists, a new code has been sent."})

    if user.is_verified:
        return jsonify({"error": "Account is already verified."}), 400

    if user.verification_sent_at:
        sent_at = user.verification_sent_at
        if sent_at.tzinfo is not None:
            sent_at = sent_at.replace(tzinfo=None)
        elapsed = (get_utc_now() - sent_at).total_seconds()
        if elapsed < 60:
            return jsonify({"error": f"Please wait {int(60 - elapsed)} seconds before requesting a new code."}), 429

    success, error = generate_and_send_otp(user)
    if not success:
        return jsonify({"error": f"Email failed: {error}"}), 500

    return jsonify({"message": "A new verification code has been sent."})


@app.route('/api/auth/verify', methods=['POST'])
@rate_limit("auth")
def verify_email():
    data = parse_json_body()
    email = str(data.get('email', '')).strip().lower()
    code = str(data.get('code', '')).strip()
    
    if email:
        rate_limit_err = enforce_counter_limit(
            failure_counter_key("verify_email", sha256_text(email)), 5, 15 * 60,
            code="too_many_attempts", message="Too many verification attempts for this email."
        )
        if rate_limit_err: return rate_limit_err
        counter_store.increment(failure_counter_key("verify_email", sha256_text(email)), 15 * 60)

    if not email or not code:
        return jsonify({"error": "Email and code required"}), 400
        
    user = User.query.filter_by(email=email).first()
    if not user:
        return jsonify({"error": "Invalid verification code"}), 401
    if not user.verification_code:
        return jsonify({"error": "No verification pending"}), 401
    if not check_password_hash(user.verification_code, code):
        return jsonify({"error": "Invalid verification code"}), 401
    if user.verification_sent_at:
        sent_at = user.verification_sent_at
        if sent_at.tzinfo is not None:
            sent_at = sent_at.replace(tzinfo=None)
        elapsed = (get_utc_now() - sent_at).total_seconds()
        if elapsed > 600:
            return jsonify({"error": "Verification code expired. Please register again."}), 401
    user.is_verified = True
    user.verification_code = None
    user.verification_sent_at = None
    apply_request_identity(user)
    db.session.commit()
    return auth_response(user)

@app.route('/api/auth/login', methods=['POST'])
@rate_limit("auth")
def login():
    data = parse_json_body()
    email = str(data.get('email', '')).strip().lower()
    password = str(data.get('password', ''))
    turnstile_response = require_turnstile_if_needed(data)
    if turnstile_response:
        return turnstile_response
    failure_key = failure_counter_key("login_fail", get_ip_hash())
    user = User.query.filter_by(email=email).first()
    if not user:
        counter_store.increment(failure_key, 15 * 60)
        return jsonify({"error": "Invalid credentials"}), 401
    if not user.password_hash:
        counter_store.increment(failure_key, 15 * 60)
        return jsonify({"error": "This account uses Google Auth. Please click 'Continue with Google'."}), 401
    if not check_password_hash(user.password_hash, password):
        counter_store.increment(failure_key, 15 * 60)
        return jsonify({"error": "Invalid credentials"}), 401
    if not user.is_verified:
        if user.verification_sent_at:
            sent_at = user.verification_sent_at
            if sent_at.tzinfo is not None:
                sent_at = sent_at.replace(tzinfo=None)
            elapsed = (get_utc_now() - sent_at).total_seconds()
            if elapsed < 60:
                return jsonify({"error": "unverified", "require_verification": True, "next_step": "email_verify", "message": "Check your email for the verification code."}), 403
        success, error = generate_and_send_otp(user)
        if not success:
            return jsonify({"error": f"Email failed: {error}"}), 500
        return jsonify({"error": "unverified", "require_verification": True, "next_step": "email_verify"}), 403
    counter_store.reset(failure_key)
    apply_request_identity(user)
    ensure_user_rollout_state(user)
    db.session.commit()
    track_login(user.id, user.subscription_tier)
    return auth_response(user)

@app.route('/api/auth/google', methods=['POST'])
@rate_limit("auth")
def google_auth():
    data = parse_json_body()
    token = data.get('credential')
    ip_limit = enforce_counter_limit(failure_counter_key("google_auth_ip", get_ip_hash()), 10, 15 * 60, code="google_auth_limited", message="Too many Google sign-in attempts from this IP.")
    if ip_limit:
        return ip_limit
    ok, turnstile_error = verify_turnstile(str(data.get('turnstile_token', '')).strip())
    if not ok:
        return jsonify({"error": turnstile_error or "Turnstile verification failed", "code": "turnstile_required"}), 403
    if not token:
        return jsonify({"error": "Missing credential"}), 400
    if not GOOGLE_CLIENT_ID:
        return jsonify({"error": "Google auth not configured on server"}), 500
    try:
        idinfo = id_token.verify_oauth2_token(token, google_requests.Request(), GOOGLE_CLIENT_ID)
        email = idinfo.get('email')
        if not idinfo.get('email_verified'):
            return jsonify({"error": "Google email is not verified. Access denied."}), 403
        if is_disposable_email(email):
            return jsonify({"error": "Disposable email addresses are not allowed.", "code": "disposable_email_blocked"}), 400
        user = User.query.filter_by(email=email).first()
        created = False
        if not user:
            user = User(
                email=email,
                google_id=idinfo.get('sub'),
                is_verified=True,
                credits=0.0,
                subscription_tier="Free",
                phone_verified=False,
                free_grant_status="pending_phone",
            )
            apply_request_identity(user, is_signup=True)
            db.session.add(user)
            db.session.commit()
            track_signup(user.id, "Free", source="google")
            created = True
        elif not user.google_id:
            user.google_id = idinfo.get('sub')
            user.is_verified = True
            db.session.commit()
        apply_request_identity(user, is_signup=created)
        ensure_user_rollout_state(user)
        db.session.commit()
        counter_store.increment(failure_counter_key("google_auth_ip", get_ip_hash()), 15 * 60)
        track_login(user.id, user.subscription_tier)
        return auth_response(user)
    except ValueError as e:
        app_logger.error(f"Google auth failed: {e}")
        return jsonify({"error": "Invalid Google token"}), 401

@app.route('/api/auth/me', methods=['GET'])
@jwt_required()
def auth_me():
    user = current_user()
    if not user:
        return jsonify({"error": "User not found"}), 404
    apply_request_identity(user)
    if user.should_reset_credits():
        user.reset_credits()
        db.session.commit()
    ensure_user_rollout_state(user)
    db.session.commit()
    return jsonify(build_user_profile_response(user))

@app.route('/api/auth/refresh', methods=['POST'])
@jwt_required(refresh=True)
def auth_refresh():
    user = current_user()
    if not user:
        return jsonify({"error": "User not found"}), 404
    apply_request_identity(user)
    ensure_user_rollout_state(user)
    db.session.commit()
    return auth_response(user)

@rate_limit("default")
@app.route('/api/auth/logout', methods=['POST'])
def auth_logout():
    response = jsonify({"success": True})
    unset_jwt_cookies(response)
    return response

@app.route('/api/auth/phone/start', methods=['POST'])
@jwt_required()
@rate_limit("auth")
def auth_phone_start():
    user = current_user()
    if not user:
        return jsonify({"error": "User not found"}), 404
    data = parse_json_body()
    ok, turnstile_error = verify_turnstile(str(data.get('turnstile_token', '')).strip())
    if not ok:
        return jsonify({"error": turnstile_error or "Turnstile verification failed", "code": "turnstile_required"}), 403
    phone_number, error = normalize_phone_number(str(data.get('phone_number', '')).strip())
    if error:
        return jsonify({"error": error}), 400
    apply_request_identity(user)
    phone_hash = sha256_text(phone_number)
    rate_response = enforce_counter_limit(failure_counter_key("phone_start", phone_hash), 5, 60 * 60, code="phone_start_limited", message="Too many verification code requests for this phone number.")
    if rate_response:
        return rate_response
    success, provider_error = start_phone_verification(phone_number)
    if not success:
        return jsonify({"error": provider_error or "Failed to send verification code"}), 400
    counter_store.increment(failure_counter_key("phone_start", phone_hash), 60 * 60)
    db.session.commit()
    return jsonify({"success": True, "message": f"Verification code sent to {mask_phone_number(phone_number)}.", "masked_phone": mask_phone_number(phone_number), "next_step": "phone_verify"})

@app.route('/api/auth/phone/verify', methods=['POST'])
@jwt_required()
@rate_limit("auth")
def auth_phone_verify():
    user = current_user()
    if not user:
        return jsonify({"error": "User not found"}), 404
    data = parse_json_body()
    phone_number, error = normalize_phone_number(str(data.get('phone_number', '')).strip())
    code = str(data.get('code', '')).strip()
    if error:
        return jsonify({"error": error}), 400
    if not code:
        return jsonify({"error": "Verification code required"}), 400
    phone_hash = sha256_text(phone_number)
    rate_response = enforce_counter_limit(failure_counter_key("phone_verify", phone_hash), 10, 60 * 60, code="phone_verify_limited", message="Too many verification attempts for this phone number.")
    if rate_response:
        return rate_response
    success, verify_error = check_phone_verification(phone_number, code)
    counter_store.increment(failure_counter_key("phone_verify", phone_hash), 60 * 60)
    if not success:
        return jsonify({"error": verify_error or "Invalid verification code"}), 400

    existing_user = User.query.filter(User.phone_number == phone_number, User.id != user.id).first()
    existing_claim = VerifiedPhoneClaim.query.filter_by(phone_hash=phone_hash).first()
    
    if existing_user and existing_user.id != user.id:
        user.phone_verified = True
        user.phone_verified_at = get_utc_now()
        user.free_grant_status = "blocked_reused_phone"
        user.risk_reason = "phone_already_attached"
        db.session.commit()
        return jsonify({"success": True, "message": "That phone number is already linked to another account. Upgrade your tier to continue.", "profile": build_user_profile_response(user), "next_step": get_user_next_step(user)})

    user.phone_number = phone_number
    user.phone_verified = True
    user.phone_verified_at = get_utc_now()
    user.risk_reason = None
    
    if not existing_claim:
        new_claim = VerifiedPhoneClaim(
            phone_hash=phone_hash,
            user_id=user.id,
            device_id_hash=get_device_hash()
        )
        db.session.add(new_claim)

    try:
        locked_user = db.session.query(User).with_for_update().get(user.id)
        if locked_user.subscription_tier == "Free":
            if locked_user.free_grant_status in {None, "", "pending_phone"}:
                device_grant_key = failure_counter_key("free_grant_device", locked_user.device_id_hash or get_device_hash())
                device_rate = enforce_counter_limit(device_grant_key, 1, 30 * 24 * 60 * 60, code="device_trial_limited", message="This device has already claimed a free grant recently.")
                if existing_claim and existing_claim.user_id != locked_user.id:
                    locked_user.free_grant_status = "blocked_reused_phone"
                elif device_rate:
                    locked_user.free_grant_status = "blocked_device_limit"
                    locked_user.risk_reason = "device_grant_limit"
                else:
                    locked_user.credits = max(float(locked_user.credits or 0), FREE_TIER_GRANT_CREDITS)
                    locked_user.free_grant_status = "granted"
                    locked_user.free_grant_claimed_at = get_utc_now()
                    counter_store.increment(device_grant_key, 30 * 24 * 60 * 60)
            elif locked_user.free_grant_status == "phone_required_existing":
                locked_user.free_grant_status = "verified_existing"
        else:
            locked_user.free_grant_status = "ready"
        db.session.commit()
        user = locked_user
    except Exception as e:
        db.session.rollback()
        return jsonify({"error": "Transaction failed, please try again."}), 500
    return jsonify({
        "success": True,
        "message": "Phone number verified.",
        "profile": build_user_profile_response(user),
        "next_step": get_user_next_step(user),
    })

@app.route('/api/subscription/upgrade', methods=['POST'])
@jwt_required()
@rate_limit("default")
def upgrade_subscription():
    user = current_user()
    if not user:
        return jsonify({"error": "User not found"}), 404
    data = parse_json_body()
    tier = data.get('tier', 'Free')
    cycle = data.get('cycle', 'monthly')
    if tier == user.subscription_tier and cycle == user.billing_cycle:
        return jsonify({"error": "Already subscribed to this tier and cycle"}), 400
    if tier not in TIER_CONFIG:
        return jsonify({"error": "Invalid tier"}), 400
    if cycle not in ('monthly', 'annual'):
        return jsonify({"error": "Invalid billing cycle"}), 400

    config = TIER_CONFIG[tier]
    
    if os.getenv('TEST_MODE') == 'true':
        old_tier = user.subscription_tier
        tier_order = ["Free", "Basic", "Plus", "Pro"]
        is_downgrade = tier_order.index(tier) < tier_order.index(old_tier)
        archived_instances =[]
        if is_downgrade:
            active_instances = InstanceModel.query.filter_by(user_id=user.id, is_archived=False).order_by(InstanceModel.created_at.desc()).all()
            if len(active_instances) > config["max_instances"]:
                for inst in active_instances[config["max_instances"]:]:
                    inst.is_archived = True
                    archived_instances.append({"id": inst.id, "name": inst.data.get("showName", "Unknown")})
            if tier != "Free":
                user.credits = min(user.credits, float(config["credits_per_month"]))
            if tier == "Basic":
                user.plus_trial_days_used = 3
            track_downgrade(user.id, old_tier, tier, len(archived_instances))
        else:
            user.credits = max(user.credits, float(config["credits_per_month"]))
            track_upgrade(user.id, old_tier, tier, billing_cycle=cycle)
        user.subscription_tier = tier
        user.subscription_started_at = get_utc_now()
        user.billing_cycle = cycle
        user.reset_credits()
        user.update_content_expiry()
        if not is_downgrade:
            restore_user_content(user)
        if (tier == "Basic" and not is_downgrade and user.plus_trial_started_at is None):
            user.plus_trial_started_at = get_utc_now()
            user.plus_trial_days_used = 0
            user.plus_trial_last_active_date = None
        db.session.commit()
        response = build_user_profile_response(user)
        if archived_instances:
            response["archived_instances"] = archived_instances
            response["downgrade_message"] = f"{len(archived_instances)} instance(s) archived due to tier limit."
        if is_downgrade:
            response["is_downgrade"] = True
        return jsonify(response)
        
    if not stripe:
        return jsonify({"error": "Payments are not configured on this server."}), 500

    try:
        price = (config["price_annual"] if cycle == 'annual' else config["price_monthly"])
        if price == 0:
            if user.stripe_subscription_id:
                try:
                    stripe.Subscription.delete(user.stripe_subscription_id)
                except Exception:
                    pass
            user.subscription_tier = "Free"
            user.stripe_subscription_id = None
            db.session.commit()
            return jsonify(build_user_profile_response(user))
            
        checkout_session = stripe.checkout.Session.create(
            customer_email=user.email, payment_method_types=['card'],
            line_items=[{'price_data': {'currency': 'usd',
                                        'product_data': {'name': f'Cristol {tier} Subscription'},
                                        'unit_amount': int(price * 100),
                                        'recurring': {'interval': 'year' if cycle == 'annual' else 'month'}},
                         'quantity': 1}],
            mode='subscription',
            success_url=(get_public_base_url() + '/?payment=success'),
            cancel_url=(get_public_base_url() + '/?payment=cancelled'),
            client_reference_id=str(user.id),
            metadata={'tier': tier, 'cycle': cycle},
        )
        return jsonify({"url": checkout_session.url})
    except Exception as e:
        return jsonify({"error": str(e)}), 500

@app.route('/api/subscription/buy-credits', methods=['POST'])
@jwt_required()
@rate_limit("default")
def buy_credit_pack():
    user = current_user()
    if not user:
        return jsonify({"error": "User not found"}), 404
    if user.subscription_tier == "Free":
        return jsonify({"error": "Credit packs require a paid subscription", "upgrade_prompt": True}), 403
    pack_id = parse_json_body().get('pack')
    if pack_id not in CREDIT_PACKS:
        return jsonify({"error": "Invalid credit pack"}), 400
    pack = CREDIT_PACKS[pack_id]
    if user.subscription_tier not in pack["available_tiers"]:
        return jsonify({"error": f"This pack is not available for {user.subscription_tier} tier"}), 400

    if os.getenv('TEST_MODE') == 'true':
        user.credits += float(pack["credits"])
        db.session.commit()
        return jsonify({"success": True, "pack": pack_id, "credits_added": pack["credits"], "credits": math.floor(user.credits), "price": pack["price"]})

    if not stripe:
        return jsonify({"error": "Payments are not configured on this server."}), 500

    try:
        checkout_session = stripe.checkout.Session.create(
            customer_email=user.email, payment_method_types=['card'],
            line_items=[{'price_data': {'currency': 'usd',
                                        'product_data': {'name': f'Cristol {pack["name"]}'},
                                        'unit_amount': int(pack["price"] * 100)}, 'quantity': 1}],
            mode='payment',
            success_url=(get_public_base_url() + '/?payment=success'),
            cancel_url=(get_public_base_url() + '/?payment=cancelled'),
            client_reference_id=str(user.id),
            metadata={'pack_id': pack_id, 'credits': pack["credits"]},
        )
        return jsonify({"url": checkout_session.url})
    except Exception as e:
        return jsonify({"error": str(e)}), 500

@app.route('/api/webhooks/stripe', methods=['POST'])
def stripe_webhook():
    payload = request.data
    sig_header = request.headers.get('Stripe-Signature')
    endpoint_secret = os.getenv('STRIPE_WEBHOOK_SECRET')
    if not stripe or not endpoint_secret:
        return jsonify({"error": "Stripe not configured"}), 400
    try:
        event = stripe.Webhook.construct_event(payload, sig_header, endpoint_secret)
    except ValueError:
        return jsonify({"error": "Invalid payload"}), 400
    except stripe.error.SignatureVerificationError:
        return jsonify({"error": "Invalid signature"}), 400
    if event['type'] == 'checkout.session.completed':
        session = event['data']['object']
        user_id = session.get('client_reference_id')
        if user_id:
            user = db.session.get(User, int(user_id))
            if user:
                metadata = session.get('metadata', {})
                if 'tier' in metadata:
                    tier = metadata['tier']
                    cycle = metadata.get('cycle', 'monthly')
                    if tier in TIER_CONFIG and cycle in ('monthly', 'annual'):
                        user.subscription_tier = tier
                        user.billing_cycle = cycle
                        user.stripe_subscription_id = session.get('subscription')
                        user.subscription_started_at = get_utc_now()
                        user.reset_credits()
                        user.update_content_expiry()
                        restore_user_content(user)
                elif 'pack_id' in metadata:
                    pack_id = metadata['pack_id']
                    if pack_id in CREDIT_PACKS:
                        user.credits += float(CREDIT_PACKS[pack_id]["credits"])
                db.session.commit()
    elif event['type'] in['customer.subscription.deleted', 'customer.subscription.canceled']:
        subscription = event['data']['object']
        user = User.query.filter_by(stripe_subscription_id=subscription.id).first()
        if user:
            user.subscription_tier = "Free"
            user.stripe_subscription_id = None
            user.reset_credits()
            user.update_content_expiry()
            db.session.commit()
    return jsonify({"success": True})

def check_storage_limit(user, req):
    config = user.get_effective_tier_config()
    max_bytes = config["storage_mb"] * 1024 * 1024
    total_bytes = 0
    shows_len = db.session.query(func.sum(func.length(cast(ShowModel.data, String)))).filter_by(user_id=user.id).scalar()
    if shows_len: total_bytes += shows_len
    inst_len = db.session.query(func.sum(func.length(cast(InstanceModel.data, String)))).filter_by(user_id=user.id).scalar()
    if inst_len: total_bytes += inst_len
    
    request_size = len(req.get_data(as_text=False)) if req.data else (req.content_length or 0)
    
    if (total_bytes + request_size) > max_bytes:
        return False, config["storage_mb"]
    return True, config["storage_mb"]

@app.route('/api/shows/generate-lore', methods=['POST'])
@jwt_required()
@rate_limit("chat")
def api_generate_lore():
    user = current_user()
    if not user:
        return jsonify({"error": "User not found"}), 404
    gate = hosted_credit_guard(user)
    if gate:
        return gate
        
    data = parse_json_body()
    show_name = data.get('showName', '').strip()
    description = data.get('description', '').strip()
    episodes = data.get('episodes', [])
    
    if not show_name:
        return jsonify({"error": "Show title is required to generate lore."}), 400
        
    # Combine all episode text into one block
    combined_episodes = ""
    for i, ep in enumerate(episodes):
        ep_name = ep.get('name', f'Episode {i+1}')
        ep_context = ep.get('context', '').strip()
        if ep_context:
            combined_episodes += f"\n### {ep_name}\n{ep_context}\n"

    episodes_prompt_section = ""
    if combined_episodes:
        episodes_prompt_section = (
            f"Here is the content of the show's episodes. Analyze this text thoroughly to build the lore:\n"
            f"--- EPISODES START ---\n"
            f"{combined_episodes}\n"
            f"--- EPISODES END ---\n\n"
        )
        
    prompt = (
        f"You are an expert world-builder and loremaster for an interactive fiction engine.\n"
        f"Create a comprehensive world lore document for a show titled '{show_name}'.\n"
        f"Description/Premise: {description or 'N/A'}\n\n"
        f"{episodes_prompt_section}"
        f"You MUST include the following elements in a well-structured format:\n"
        f"1. The Show Name.\n"
        f"2. How the characters speak (tone, dialects, vocabulary).\n"
        f"3. Each species or main character, and detailed stuff about them.\n"
        f"4. Rules of the world (physics, magic, technology, society).\n"
        f"5. The basics and the not-basics (deep lore, hidden secrets).\n"
        f"6. Everything essential about the show's setting to maintain absolute continuity.\n\n"
        f"Output ONLY the raw Markdown text for the lore. Do not include introductory chatter."
    )
    
    summary_model = user.summary_model or DEFAULT_SUMMARIZATION_MODEL
    api_key = get_effective_api_key_for_user(user)
    if not api_key:
        return jsonify({"error": "No API key configured."}), 400
        
    messages = [
        {"role": "system", "content": "You are a helpful creative assistant."},
        {"role": "user", "content": prompt}
    ]
    
    config = user.get_effective_tier_config()
    priority = config.get("priority_processing", False)
    
    # We use a higher max_tokens here since world lore can be quite detailed
    result, error, cost = call_model(messages, summary_model, api_key, max_tokens=4000, temperature=0.7, priority=priority)
    
    if error:
        return jsonify({"error": f"Generation failed: {error}"}), 500
        
    credit_cost = usd_to_credits(cost)
    if credit_cost > 0:
        user.deduct_credit(credit_cost)
        db.session.commit()
        
    return jsonify({"lore": result.strip(), "credits_used": math.floor(credit_cost)})

@app.route('/api/shows', methods=['GET', 'POST'])
@jwt_required()
@rate_limit("default")
def handle_shows():
    try:
        user = current_user()
        if not user:
            return jsonify({"error": "User not found"}), 404
        if request.method == 'POST':
            is_within_limit, limit_mb = check_storage_limit(user, request)
            if not is_within_limit:
                return jsonify({"error": f"Storage limit exceeded ({limit_mb}MB max). Please upgrade.", "upgrade_prompt": True}), 413
            data = parse_json_body()
            if not data.get('name', '').strip():
                return jsonify({"error": "Show name is required"}), 400
            config = user.get_effective_tier_config()
            lore = data.get('lore', '')
            profile = data.get('profile', '')
            if len(lore) > config["max_lore_length"]:
                return jsonify({"error": f"Lore exceeds {config['max_lore_length']} chars"}), 400
            if len(profile) > config["max_profile_length"]:
                return jsonify({"error": f"Profile exceeds {config['max_profile_length']} chars"}), 400
            new_id = generate_unique_id("show_")
            new_show = {"id": new_id, "name": data.get("name", "New Show").strip(), "description": data.get("description", ""), "lore": lore, "profile": profile, "episodes": data.get("episodes",[])}
            user_id = user.id
            @copy_current_request_context
            def generate():
                try:
                    with app.app_context():
                        user_obj = db.session.get(User, user_id)
                        show = ShowModel(id=new_id, user_id=user_obj.id, data=new_show)
                        db.session.add(show)
                        db.session.commit()
                        yield json.dumps({"type": "complete", "show": new_show, "cost": 0.0}) + "\n"
                except Exception as e:
                    yield json.dumps({"type": "error", "message": str(e)}) + "\n"
            return Response(generate(), mimetype='application/x-ndjson')
        shows = ShowModel.query.filter_by(user_id=user.id, is_archived=False).all()
        return jsonify([s.data for s in shows])
    except Exception as e:
        db.session.rollback()
        app_logger.error(f"Shows route error: {e}")
        return jsonify({"error": str(e)}), 500

@app.route('/api/shows/<show_id>', methods=['GET', 'PUT', 'DELETE'])
@jwt_required()
@rate_limit("default")
def handle_show_id(show_id):
    try:
        user = current_user()
        if not user:
            return jsonify({"error": "User not found"}), 404
        show = ShowModel.query.filter_by(id=show_id, user_id=user.id).first()
        if not show:
            return jsonify({"error": "Show not found"}), 404
        if request.method == 'DELETE':
            instances = InstanceModel.query.filter_by(user_id=user.id).all()
            for i in instances:
                if i.data.get('showId') == show_id:
                    db.session.delete(i)
            db.session.delete(show)
            db.session.commit()
            return jsonify({"success": True})
        if request.method == 'GET':
            return jsonify(show.data)
        
        is_within_limit, limit_mb = check_storage_limit(user, request)
        if not is_within_limit:
            return jsonify({"error": f"Storage limit exceeded ({limit_mb}MB max). Please upgrade.", "upgrade_prompt": True}), 413

        data = parse_json_body()
        config = user.get_effective_tier_config()
        show_data = dict(show.data)
        if 'episodes' in data:
            for i, ep in enumerate(data['episodes']):
                if len(ep.get('context', '')) > config["max_episode_length"]:
                    return jsonify({"error": f"Episode {i + 1} exceeds {config['max_episode_length']} characters"}), 400
            if len(data['episodes']) > config["max_episodes"]:
                return jsonify({"error": f"Max {config['max_episodes']} episodes allowed", "upgrade_prompt": True}), 400
        if 'lore' in data and len(data['lore']) > config["max_lore_length"]:
            return jsonify({"error": "Lore exceeds max length"}), 400
        if 'profile' in data and len(data['profile']) > config["max_profile_length"]:
            return jsonify({"error": "Profile exceeds max length"}), 400
        
        for field in ['name', 'description', 'lore', 'profile', 'episodes', 'settings']:
            if field in data:
                show_data[field] = data[field]
        show_data['id'] = show_id
        if not show_data.get('name', '').strip():
            return jsonify({"error": "Show name is required"}), 400
        user_id = user.id
        
        @copy_current_request_context
        def generate():
            try:
                with app.app_context():
                    show_obj = ShowModel.query.filter_by(id=show_id, user_id=user_id).first()
                    show_obj.data = show_data
                    save_model_data(show_obj)
                    yield json.dumps({"type": "complete", "show": show_obj.data, "cost": 0.0}) + "\n"
            except Exception as e:
                yield json.dumps({"type": "error", "message": str(e)}) + "\n"
        return Response(generate(), mimetype='application/x-ndjson')
    except Exception as e:
        db.session.rollback()
        app_logger.error(f"Show update error: {e}")
        return jsonify({"error": str(e)}), 500

@app.route('/api/instances', methods=['GET', 'POST'])
@jwt_required()
@rate_limit("default")
def handle_instances():
    try:
        user = current_user()
        if not user:
            return jsonify({"error": "User not found"}), 404
        if request.method == 'POST':
            is_within_limit, limit_mb = check_storage_limit(user, request)
            if not is_within_limit:
                return jsonify({"error": f"Storage limit exceeded ({limit_mb}MB max). Please upgrade.", "upgrade_prompt": True}), 413
            can_create, current_count, max_count = check_instance_limit(user)
            if not can_create:
                return jsonify({"error": f"Maximum {max_count} instances allowed", "upgrade_prompt": True}), 400
            data = parse_json_body()
            show = ShowModel.query.filter_by(id=data.get('showId'), user_id=user.id).first()
            if not show:
                return jsonify({"error": "Show not found"}), 404
            show_data = show.data
            instance_id = generate_unique_id("inst_")
            instance_data = {
                "id": instance_id, "showId": show_data['id'],
                "showName": show_data['name'], "currentEpisodeIndex": 0,
                "messages": [], "summaryHistory":[],
                "transcript_progress": {"episodeIndex": 0, "chunkIndex": 0},
                "current_chunk_id": 0,
                "max_chunk_reached": 0,
                "played_segments":[],
                "rollingSummary": "", "rollingSummaryCount": 0,
                "lastPlayed": get_utc_now().isoformat(),
                "lore": show_data.get('lore', ''), "profile": show_data.get('profile', ''),
                "episodes": show_data.get('episodes',[]), "sharing": "private",
                "settings": {"chunk_mode": "auto"}
            }
            inst = InstanceModel(id=instance_id, user_id=user.id, data=instance_data)
            db.session.add(inst)
            db.session.commit()
            track_event("instance_created", user_id=user.id, to_tier=user.subscription_tier)
            return jsonify(instance_data), 201
        include_archived = (request.args.get('include_archived', 'false').lower() == 'true')
        instances = (InstanceModel.query.filter_by(user_id=user.id).all() if include_archived else InstanceModel.query.filter_by(user_id=user.id, is_archived=False).all())
        result =[]
        for i in instances:
            inst_data = dict(i.data)
            msgs = inst_data.get('messages',[])
            for idx, m in enumerate(msgs):
                if 'id' not in m:
                    m['id'] = f"legacy_{i.id}_{idx}"
            inst_data['messages'] = msgs
            inst_data['is_archived'] = i.is_archived
            inst_data['is_owner'] = True
            result.append(inst_data)
        result.sort(key=lambda x: x.get('lastPlayed', ''), reverse=True)
        return jsonify(result)
    except Exception as e:
        db.session.rollback()
        app_logger.error(f"Instances route error: {e}")
        return jsonify({"error": str(e)}), 500

@app.route('/api/instances/<inst_id>', methods=['GET', 'PUT', 'DELETE'])
@jwt_required()
@rate_limit("default")
def handle_instance_id(inst_id):
    try:
        user = current_user()
        if not user:
            return jsonify({"error": "User not found"}), 404
        inst = InstanceModel.query.filter_by(id=inst_id, user_id=user.id).first()
        if not inst:
            return jsonify({"error": "Instance not found"}), 404
        if request.method == 'DELETE':
            db.session.delete(inst)
            db.session.commit()
            return jsonify({"success": True})
        if request.method == 'GET':
            inst_data = dict(inst.data)
            msgs = inst_data.get('messages',[])
            for idx, m in enumerate(msgs):
                if 'id' not in m:
                    m['id'] = f"legacy_{inst.id}_{idx}"
            inst_data['messages'] = msgs
            inst_data['is_archived'] = inst.is_archived
            inst_data['is_owner'] = True
            return jsonify(inst_data)
        if inst.is_archived:
            return jsonify({"error": "Cannot modify archived instance.", "is_archived": True, "upgrade_prompt": True}), 403
            
        is_within_limit, limit_mb = check_storage_limit(user, request)
        if not is_within_limit:
            return jsonify({"error": f"Storage limit exceeded ({limit_mb}MB max). Please upgrade.", "upgrade_prompt": True}), 413

        req_data = parse_json_body()
        inst_data = dict(inst.data)
        if 'messages' in req_data:
            old_msgs = inst_data.get('messages', [])
            new_msgs = req_data['messages']
            if len(new_msgs) > 2000:
                return jsonify({"error": "Too many messages in payload"}), 400
            sanitized_msgs = []
            for m in new_msgs:
                if not isinstance(m, dict):
                    continue
                role = m.get('role', '')
                content = m.get('content', '')
                if role not in ('user', 'assistant', 'ai'):
                    continue
                if not isinstance(content, str):
                    content = str(content)
                sanitized_m = {
                    'id': str(m.get('id', generate_unique_id("msg_"))),
                    'role': role,
                    'content': content,
                }
                if isinstance(m.get('meta'), dict):
                    sanitized_m['meta'] = m['meta']
                if isinstance(m.get('reasoning'), str):
                    sanitized_m['reasoning'] = m['reasoning']
                if isinstance(m.get('prompt_hash'), str):
                    sanitized_m['prompt_hash'] = m['prompt_hash']
                if m.get('partial') is True:
                    sanitized_m['partial'] = True
                sanitized_msgs.append(sanitized_m)
            new_msgs = sanitized_msgs

            for idx, m in enumerate(new_msgs):
                if 'id' not in m:
                    m['id'] = generate_unique_id("msg_")
            old_msg_lookup = {str(m['id']): m for m in old_msgs if m.get('id')}
            old_hash_map = {}
            for m in old_msgs:
                if m.get('role') in['assistant', 'ai'] and 'prompt_hash' in m:
                    old_hash_map[m['prompt_hash']] = m.get('content', '')
            changed_hashes = {}
            for i, m in enumerate(new_msgs):
                m_id = m.get('id')
                old_m = None
                if m_id and str(m_id) in old_msg_lookup:
                    candidate = old_msg_lookup[str(m_id)]
                    if candidate.get('role') == m.get('role'):
                        old_m = candidate
                if not old_m and i < len(old_msgs):
                    candidate = old_msgs[i]
                    if candidate.get('role') == m.get('role') and candidate.get('content') == m.get('content'):
                        old_m = candidate
                if old_m:
                    if 'meta' in old_m:
                        if 'meta' not in m:
                            m['meta'] = copy.deepcopy(old_m['meta'])
                        else:
                            for k, v in old_m['meta'].items():
                                if k not in m['meta']:
                                    m['meta'][k] = v
                    if m.get('role') in ['assistant', 'ai'] and 'prompt_hash' in m:
                        phash = m['prompt_hash']
                        new_content = m.get('content', '')
                        if phash in old_hash_map and old_hash_map[phash] != new_content:
                            changed_hashes[phash] = new_content
            if changed_hashes:
                update_finetuning_edits(changed_hashes)
            inst_data['messages'] = new_msgs
            if 'current_chunk_id' not in req_data:
                ep_idx, ep_name, ep_text, chunks = get_episode_chunks(inst_data)
                if new_msgs:
                    last_msg = new_msgs[-1]
                    base_chunk = 0
                    search_msgs = new_msgs[:-1] if len(new_msgs) > 1 else new_msgs
                    for m in reversed(search_msgs):
                        if 'meta' in m:
                            if m.get('role') in['assistant', 'ai'] and 'postTurnChunk' in m['meta']:
                                base_chunk = m['meta']['postTurnChunk']
                                break
                            elif 'chunk_id' in m['meta']:
                                base_chunk = m['meta']['chunk_id']
                                break
                            elif 'selectedChunk' in m['meta']:
                                base_chunk = m['meta']['selectedChunk']
                                break
                    if base_chunk == 0 and last_msg.get('role') == 'user' and 'meta' in last_msg:
                        if 'chunk_id' in last_msg['meta']:
                            base_chunk = last_msg['meta']['chunk_id']
                        elif 'selectedChunk' in last_msg['meta']:
                            base_chunk = last_msg['meta']['selectedChunk']
                    if chunks:
                        base_chunk = max(0, min(int(base_chunk), len(chunks) - 1))
                    else:
                        base_chunk = 0
                    _put_chunk_mode = user.chunk_selection_mode or 'auto'
                    if last_msg.get('role') in['assistant', 'ai']:
                        inst_data['max_chunk_reached'] = base_chunk
                        inst_data['current_chunk_id'] = base_chunk
                        new_chunk_id = base_chunk
                        inst_data['current_chunk_id'] = new_chunk_id
                        inst_data.setdefault('transcript_progress', {})['chunkIndex'] = new_chunk_id
                        if 'meta' not in last_msg:
                            last_msg['meta'] = {}
                        last_msg['meta']['postTurnChunk'] = new_chunk_id
                        last_msg['meta']['chunk_id'] = base_chunk
                    elif last_msg.get('role') == 'user':
                        inst_data['current_chunk_id'] = base_chunk
                        new_chunk_id = base_chunk
                        inst_data['current_chunk_id'] = new_chunk_id
                        inst_data.setdefault('transcript_progress', {})['chunkIndex'] = new_chunk_id
                        if 'meta' not in last_msg:
                            last_msg['meta'] = {}
                        last_msg['meta']['chunk_id'] = new_chunk_id
                    else:
                        inst_data['current_chunk_id'] = 0
                        inst_data.setdefault('transcript_progress', {})['chunkIndex'] = 0
                    inst_data['max_chunk_reached'] = inst_data['current_chunk_id']

        for key in INSTANCE_CLIENT_SETTABLE_KEYS:
            if key not in req_data:
                continue

            if key in ('episodes', 'summaryHistory', 'played_segments'):
                if not isinstance(req_data[key], list): continue
            elif key in ('lore', 'profile', 'rollingSummary', 'currentEpisodeIndex'):
                if key == 'currentEpisodeIndex' and not isinstance(req_data[key], int):
                    try: req_data[key] = int(req_data[key])
                    except (ValueError, TypeError): continue
                elif key != 'currentEpisodeIndex' and not isinstance(req_data[key], str):
                    continue
                
                # ENFORCE TIER LIMITS ON INSTANCE LEVEL TO PREVENT TOKEN INFLATION
                config = user.get_effective_tier_config()
                if key == 'lore' and len(req_data[key]) > config["max_lore_length"]:
                    continue
                if key == 'profile' and len(req_data[key]) > config["max_profile_length"]:
                    continue
            elif key in ('rollingSummaryCount', 'current_chunk_id'):
                if not isinstance(req_data[key], int):
                    try: req_data[key] = int(req_data[key])
                    except (ValueError, TypeError): continue

            if key == 'current_chunk_id':
                ep_idx2, ep_name2, ep_text2, chunks2 = get_episode_chunks(inst_data)
                val = int(req_data[key])
                inst_data[key] = max(0, min(val, len(chunks2) - 1)) if chunks2 else 0
            elif key == 'settings':
                incoming_settings = req_data[key]
                if isinstance(incoming_settings, dict):
                    current_settings = inst_data.get('settings', {})
                    for sk in INSTANCE_SETTINGS_ALLOWED_KEYS:
                        if sk in incoming_settings:
                            current_settings[sk] = incoming_settings[sk]
                    inst_data['settings'] = current_settings
            elif key == 'currentEpisodeIndex':
                episodes = inst_data.get('episodes', [])
                val = int(req_data[key])
                inst_data[key] = max(0, min(val, len(episodes)))
            else:
                inst_data[key] = req_data[key]

        inst_data['lastPlayed'] = get_utc_now().isoformat()
        inst.data = inst_data
        save_model_data(inst)
        return jsonify(inst.data)
    except Exception as e:
        db.session.rollback()
        app_logger.error(f"Instance update error: {e}")
        return jsonify({"error": str(e)}), 500

@app.route('/api/instances/<inst_id>/archive', methods=['POST'])
@rate_limit("default")
@jwt_required()
def archive_instance(inst_id):
    user = current_user()
    if not user:
        return jsonify({"error": "User not found"}), 404
    inst = InstanceModel.query.filter_by(id=inst_id, user_id=user.id).first()
    if not inst:
        return jsonify({"error": "Instance not found"}), 404
    inst.is_archived = True
    db.session.commit()
    return jsonify({"success": True, "message": "Instance archived"})

@app.route('/api/instances/<inst_id>/unarchive', methods=['POST'])
@rate_limit("default")
@jwt_required()
def unarchive_instance(inst_id):
    user = current_user()
    if not user:
        return jsonify({"error": "User not found"}), 404
    can_create, current_count, max_count = check_instance_limit(user)
    if not can_create:
        return jsonify({"error": f"Cannot unarchive: already at maximum {max_count} instances", "upgrade_prompt": True}), 400
    inst = InstanceModel.query.filter_by(id=inst_id, user_id=user.id).first()
    if not inst:
        return jsonify({"error": "Instance not found"}), 404
    inst.is_archived = False
    db.session.commit()
    return jsonify({"success": True, "message": "Instance unarchived"})

@app.route('/api/instances/<inst_id>/branch', methods=['POST'])
@jwt_required()
@rate_limit("default")
def branch_instance(inst_id):
    user = current_user()
    if not user:
        return jsonify({"error": "User not found"}), 404
    can_create, current_count, max_count = check_instance_limit(user)
    if not can_create:
        return jsonify({"error": f"Maximum {max_count} instances allowed", "upgrade_prompt": True}), 400
    config = user.get_effective_tier_config()
    if not config.get('branches'):
        return jsonify({"error": "Instance branching requires Pro tier.", "upgrade_prompt": True}), 403
    inst = load_instance_or_404(inst_id, user.id)
    data = parse_json_body()
    message_id = data.get('message_id')
    inst_data = dict(inst.data)
    messages = inst_data.get('messages',[])
    target_idx = -1
    for i, msg in enumerate(messages):
        if msg.get('id') == message_id:
            target_idx = i
            break
    if target_idx != -1:
        messages = messages[:target_idx + 1]
    new_id = generate_unique_id("inst_")
    new_data = dict(inst_data)
    new_data['id'] = new_id
    new_data['messages'] = messages
    new_data['showName'] = f"{new_data.get('showName', 'Show')} (Branch)"
    new_data['lastPlayed'] = get_utc_now().isoformat()
    new_data['summaryHistory'] = inst_data.get('summaryHistory', []).copy()
    if messages:
        last_msg = messages[-1]
        if last_msg.get('role') in ['assistant', 'ai']:
            new_data['current_chunk_id'] = last_msg.get('meta', {}).get('postTurnChunk', 0)
        else:
            new_data['current_chunk_id'] = last_msg.get('meta', {}).get('chunk_id', 0)
    else:
        new_data['current_chunk_id'] = 0
    new_data['max_chunk_reached'] = new_data['current_chunk_id']
    new_data.setdefault('transcript_progress', {})['chunkIndex'] = new_data['current_chunk_id']
    new_inst = InstanceModel(id=new_id, user_id=user.id, data=new_data)
    db.session.add(new_inst)
    db.session.commit()
    track_event("instance_branched", user_id=user.id, to_tier=user.subscription_tier)
    return jsonify(new_data), 201

@app.route('/api/instances/<inst_id>/chunks', methods=['GET'])
@jwt_required()
@rate_limit("default")
def get_instance_chunks(inst_id):
    user = current_user()
    if not user:
        return jsonify({"error": "User not found"}), 404
    inst = load_instance_or_404(inst_id, user.id)
    inst_data = inst.data
    ep_idx, ep_name, ep_text, chunks = get_episode_chunks(inst_data)
    chunk_info =[]
    for i, chunk in enumerate(chunks):
        preview = get_chunk_preview(chunk, 150)
        chunk_info.append({
            "index": i,
            "preview": preview,
            "length": len(chunk),
            "played": i in inst_data.get('played_segments',[]),
            "full_text": chunk,
        })
    return jsonify({"episodeIndex": ep_idx, "episodeName": ep_name, "currentChunkId": inst_data.get('current_chunk_id', 0), "totalChunks": len(chunks), "chunks": chunk_info, "playedSegments": inst_data.get('played_segments',[])})

@app.route('/api/instances/<inst_id>/select-chunk', methods=['POST'])
@jwt_required()
@rate_limit("default")
def manual_select_chunk(inst_id):
    user = current_user()
    if not user:
        return jsonify({"error": "User not found"}), 404
    inst = load_instance_or_404(inst_id, user.id)
    if inst.is_archived:
        return jsonify({"error": "Cannot modify archived instance"}), 403
    data = parse_json_body()
    chunk_id = data.get('chunkId')
    if chunk_id is None:
        return jsonify({"error": "Missing chunkId"}), 400
    inst_data = dict(inst.data)
    ep_idx, ep_name, ep_text, chunks = get_episode_chunks(inst_data)
    chunk_id = max(0, min(int(chunk_id), len(chunks) - 1)) if chunks else 0
    inst_data['current_chunk_id'] = chunk_id
    inst_data['max_chunk_reached'] = chunk_id
    progress = inst_data.setdefault('transcript_progress', {})
    progress['episodeIndex'] = ep_idx
    progress['chunkIndex'] = chunk_id
    inst_data['lastPlayed'] = get_utc_now().isoformat()
    inst.data = inst_data
    save_model_data(inst)
    return jsonify({"success": True, "selectedChunk": chunk_id, "totalChunks": len(chunks)})

@app.route('/api/instances/<inst_id>/share', methods=['POST'])
@jwt_required()
def share_instance(inst_id):
    user = current_user()
    if not user:
        return jsonify({"error": "User not found"}), 404
    inst = load_instance_or_404(inst_id, user.id)
    sharing = parse_json_body().get('sharing', 'private')
    if sharing not in ('private', 'read_only', 'full'):
        return jsonify({"error": "Invalid sharing value"}), 400
    if sharing == 'full' and not user.get_effective_tier_config().get('full_sharing'):
        return jsonify({"error": "Full collaboration requires Plus tier or higher"}), 403
    d = dict(inst.data)
    d['sharing'] = sharing
    inst.data = d
    save_model_data(inst)
    return jsonify({"success": True, "sharing": sharing})

@app.route('/api/instances/<inst_id>/export', methods=['GET'])
@jwt_required()
@rate_limit("default")
def export_instance(inst_id):
    user = current_user()
    if not user:
        return jsonify({"error": "User not found"}), 404
    inst = InstanceModel.query.filter_by(id=inst_id, user_id=user.id).first()
    if not inst:
        return jsonify({"error": "Instance not found"}), 404
    return _generate_export_response(inst)


@app.route('/api/shared/instances/<inst_id>/export', methods=['GET'])
@rate_limit("default")
def export_shared_instance(inst_id):
    inst = InstanceModel.query.filter_by(id=inst_id).first()
    if not inst:
        return jsonify({"error": "Instance not found"}), 404
    sharing = inst.data.get('sharing', 'private')
    if sharing == 'private':
        return jsonify({"error": "Instance not found or private"}), 404
    return _generate_export_response(inst)


def _generate_export_response(inst):
    """Helper to generate export response in various formats."""
    export_format = request.args.get('format', 'markdown').lower()
    if export_format not in ('json', 'markdown', 'txt'):
        return jsonify({"error": "Invalid format. Use json, markdown, or txt."}), 400

    inst_data = inst.data
    messages = inst_data.get('messages', [])
    show_name = inst_data.get('showName', 'Unknown')
    safe_filename = re.sub(r'[^\w\-.]', '_', show_name)[:50]

    if export_format == 'json':
        export_data = {
            "show_name": show_name,
            "show_id": inst_data.get('showId'),
            "instance_id": inst.id,
            "exported_at": get_utc_now().isoformat() + "Z",
            "current_episode_index": inst_data.get('currentEpisodeIndex', 0),
            "episodes": [
                {"name": ep.get('name', ''), "context": ep.get('context', '')}
                for ep in inst_data.get('episodes', [])
            ],
            "summary_history": inst_data.get('summaryHistory', []),
            "rolling_summary": inst_data.get('rollingSummary', ''),
            "lore": inst_data.get('lore', ''),
            "profile": inst_data.get('profile', ''),
            "messages": [
                {
                    "role": m.get('role'),
                    "content": m.get('content', '').replace('[CHUNK_COMPLETE]', '').strip(),
                    "reasoning": m.get('reasoning', ''),
                    "timestamp": m.get('meta', {}).get('timestamp') if isinstance(m.get('meta'), dict) else None,
                }
                for m in messages
            ],
        }
        response = make_response(json_dumps(export_data, indent=2, ensure_ascii=False))
        response.mimetype = 'application/json'
        response.headers['Content-Disposition'] = f'attachment; filename="{safe_filename}_{inst.id[:8]}.json"'
        return response

    elif export_format == 'markdown':
        lines = []
        lines.append(f"# {show_name}")
        lines.append("")
        lines.append(f"*Exported from Cristol on {get_utc_now().strftime('%Y-%m-%d at %H:%M UTC')}*")
        lines.append("")

        episodes = inst_data.get('episodes', [])
        current_ep_idx = inst_data.get('currentEpisodeIndex', 0)
        if episodes:
            lines.append("## Episodes")
            for i, ep in enumerate(episodes):
                marker = " ← *current*" if i == current_ep_idx else ""
                lines.append(f"- **Episode {i+1}: {ep.get('name', 'Untitled')}**{marker}")
            lines.append("")

        rolling_summary = inst_data.get('rollingSummary', '').strip()
        if rolling_summary:
            lines.append("## Running Summary")
            lines.append("")
            lines.append(rolling_summary)
            lines.append("")

        summary_history = inst_data.get('summaryHistory', [])
        if summary_history:
            lines.append("## Episode Summaries")
            lines.append("")
            for entry in summary_history:
                ep_name = entry.get('episodeName', 'Unknown')
                summary = entry.get('summary', '')
                timestamp = entry.get('timestamp', '')
                lines.append(f"### {ep_name}")
                if timestamp:
                    try:
                        dt = timestamp.replace('Z', '+00:00')
                        from datetime import datetime as dt_cls
                        parsed = dt_cls.fromisoformat(dt)
                        lines.append(f"*{parsed.strftime('%Y-%m-%d %H:%M UTC')}*")
                    except Exception:
                        pass
                lines.append("")
                lines.append(summary)
                lines.append("")

        if messages:
            lines.append("---")
            lines.append("")
            lines.append("## Chat Log")
            lines.append("")

            current_ep = None
            for msg in messages:
                role = msg.get('role', 'user')
                content = msg.get('content', '').replace('[CHUNK_COMPLETE]', '').strip()
                if not content:
                    continue

                meta = msg.get('meta', {})
                if isinstance(meta, dict):
                    ep_idx = meta.get('episodeIndex')
                    if ep_idx is not None and ep_idx != current_ep:
                        current_ep = ep_idx
                        if ep_idx < len(episodes):
                            lines.append(f"***Episode: {episodes[ep_idx].get('name', f'Episode {ep_idx+1}')}***")
                            lines.append("")

                if role == 'user':
                    lines.append(f"### User")
                else:
                    lines.append(f"### Cristol")

                lines.append("")
                lines.append(content)
                lines.append("")

        response = make_response("\n".join(lines))
        response.mimetype = 'text/markdown; charset=utf-8'
        response.headers['Content-Disposition'] = f'attachment; filename="{safe_filename}_{inst.id[:8]}.md"'
        return response

    else:  # txt
        separator = "=" * 60
        thin_sep = "-" * 40

        lines = []
        lines.append(separator)
        lines.append(f"  {show_name}")
        lines.append(f"  Exported: {get_utc_now().strftime('%Y-%m-%d at %H:%M UTC')}")
        lines.append(separator)
        lines.append("")

        episodes = inst_data.get('episodes', [])
        current_ep_idx = inst_data.get('currentEpisodeIndex', 0)
        if episodes:
            lines.append("EPISODES:")
            for i, ep in enumerate(episodes):
                marker = " (current)" if i == current_ep_idx else ""
                lines.append(f"  {i+1}. {ep.get('name', 'Untitled')}{marker}")
            lines.append("")

        rolling_summary = inst_data.get('rollingSummary', '').strip()
        if rolling_summary:
            lines.append(thin_sep)
            lines.append("RUNNING SUMMARY:")
            lines.append(thin_sep)
            lines.append("")
            lines.append(rolling_summary)
            lines.append("")

        summary_history = inst_data.get('summaryHistory', [])
        if summary_history:
            lines.append(thin_sep)
            lines.append("EPISODE SUMMARIES:")
            lines.append(thin_sep)
            lines.append("")
            for entry in summary_history:
                ep_name = entry.get('episodeName', 'Unknown')
                summary = entry.get('summary', '')
                lines.append(f"[{ep_name}]")
                lines.append(summary)
                lines.append("")

        if messages:
            lines.append(separator)
            lines.append("CHAT LOG:")
            lines.append(separator)
            lines.append("")

            for msg in messages:
                role = msg.get('role', 'user')
                content = msg.get('content', '').replace('[CHUNK_COMPLETE]', '').strip()
                if not content:
                    continue

                if role == 'user':
                    lines.append(f"[PLAYER]")
                else:
                    lines.append(f"[NARRATOR]")
                lines.append("")
                lines.append(content)
                lines.append("")
                lines.append(thin_sep)
                lines.append("")

        response = make_response("\n".join(lines))
        response.mimetype = 'text/plain; charset=utf-8'
        response.headers['Content-Disposition'] = f'attachment; filename="{safe_filename}_{inst.id[:8]}.txt"'
        return response

@app.route('/api/shared/instances/<inst_id>', methods=['GET'])
@rate_limit("default")
def get_shared_instance(inst_id):
    inst = InstanceModel.query.filter_by(id=inst_id).first()
    if not inst:
        return jsonify({"error": "Instance not found"}), 404
    sharing = inst.data.get('sharing', 'private')
    is_owner = False
    auth_header = request.headers.get('Authorization')
    if auth_header and auth_header.startswith('Bearer '):
        try:
            token = auth_header.split(' ')[1]
            decoded = decode_token(token)
            if int(decoded['sub']) == inst.user_id:
                is_owner = True
        except Exception as e:
            app_logger.warning(f"Shared instance token decode error: {e}")
            pass
    if sharing == 'private' and not is_owner:
        return jsonify({"error": "Instance not found or private"}), 404
    d = dict(inst.data)
    msgs = d.get('messages',[])
    for idx, m in enumerate(msgs):
        if 'id' not in m:
            m['id'] = f"legacy_{inst.id}_{idx}"
    d['messages'] = msgs
    d['is_archived'] = inst.is_archived
    d['is_owner'] = is_owner
    owner = db.session.get(User, inst.user_id)
    d['creator_tier'] = owner.subscription_tier if owner else "Free"
    return jsonify(d)

@app.route('/api/summarize', methods=['POST'])
@jwt_required()
@rate_limit("chat")
def route_summarize():
    user = current_user()
    if not user:
        return jsonify({"error": "User not found"}), 404
    gate = hosted_credit_guard(user)
    if gate:
        return gate
    text = parse_json_body().get('text', '')
    if not text.strip():
        return jsonify({"summary": "[No events recorded to summarize]"})
    summary, cost_usd = call_summary_api(text, user, auto=False)
    credit_cost = usd_to_credits(cost_usd)
    if credit_cost > 0:
        user.deduct_credit(credit_cost)
        db.session.commit()
    return jsonify({"summary": summary, "credits_used": math.floor(credit_cost)})

@app.route('/api/instances/<inst_id>/advance', methods=['POST'])
@jwt_required()
@rate_limit("chat")
def advance_episode(inst_id):
    user = current_user()
    if not user:
        return jsonify({"error": "User not found"}), 404
    gate = hosted_credit_guard(user)
    if gate:
        return gate
    inst = load_instance_or_404(inst_id, user.id)
    if inst.is_archived:
        return jsonify({"error": "Cannot modify archived instance"}), 403
    custom_summary = parse_json_body().get('summary')
    inst_data = dict(inst.data)
    total_cost_usd = 0.0
    if custom_summary is not None:
        summary_text = str(custom_summary).strip()
    else:
        transcript = "".join([f"{'USER' if m.get('role') == 'user' else 'STORY'}:\n{m.get('content', '')}\n" for m in inst_data.get('messages', [])])
        if not transcript.strip():
            transcript = "[No events recorded this session]"
        summary_text, sum_cost = call_summary_api(transcript, user, auto=True)
        total_cost_usd += sum_cost
    ep_idx = inst_data.get('currentEpisodeIndex', 0)
    episodes = inst_data.get('episodes', [])
    ep_name = (episodes[ep_idx]['name'] if ep_idx < len(episodes) else f"Episode {ep_idx + 1}")
    if 'summaryHistory' not in inst_data:
        inst_data['summaryHistory'] =[]
    inst_data['summaryHistory'].append({"episodeName": ep_name, "summary": summary_text, "timestamp": get_utc_now().isoformat()})
    new_ep_idx = ep_idx + 1
    inst_data['currentEpisodeIndex'] = new_ep_idx
    inst_data['messages'] = []
    inst_data['transcript_progress'] = {"episodeIndex": new_ep_idx, "chunkIndex": 0}
    inst_data['current_chunk_id'] = 0
    inst_data['max_chunk_reached'] = 0
    inst_data['played_segments'] =[]
    inst_data['rollingSummary'] = ""
    inst_data['rollingSummaryCount'] = 0
    inst_data['lastPlayed'] = get_utc_now().isoformat()
    credit_cost = usd_to_credits(total_cost_usd)
    if credit_cost > 0:
        user.deduct_credit(credit_cost)
    inst.data = inst_data
    save_model_data(inst)
    return jsonify({"success": True, "summary": summary_text, "nextEpisodeIndex": inst_data['currentEpisodeIndex'], "credits_used": math.floor(credit_cost)})

@app.route('/api/chat', methods=['POST'])
@jwt_required()
@rate_limit("chat")
def chat():
    try:
        user = current_user()
        if not user:
            return jsonify({"error": "Unauthorized"}), 401
        gate = hosted_credit_guard(user)
        if gate:
            return gate
        data = parse_json_body()
        instance_id = data.get('instanceId')
        evaluate_only = data.get('evaluate_only', False)
        if not instance_id:
            return jsonify({"error": "Missing instanceId"}), 400
        inst = InstanceModel.query.filter_by(id=instance_id).first()
        if not inst:
            return jsonify({"error": "Not found"}), 404
        is_owner = (inst.user_id == user.id)
        sharing = inst.data.get('sharing', 'private')
        if not is_owner and sharing != 'full':
            return jsonify({"error": "No permission to chat here. Full collaboration mode is not enabled."}), 403
        if inst.is_archived:
            return jsonify({"error": "Cannot chat in archived instance.", "is_archived": True, "upgrade_prompt": True}), 403
        inst_data = copy.deepcopy(inst.data)
        user_input = data.get('message', '')[:10000].strip()
        
        requested_model = data.get('model')
        allowed_model_ids = {m["id"] for m in DEFAULT_MODELS}
        if requested_model and requested_model not in allowed_model_ids:
            requested_model = None
        model = requested_model if requested_model else user.chat_model
        
        chunk_mode_raw = data.get('chunkMode', user.chunk_selection_mode or 'auto')
        chunk_mode = chunk_mode_raw if chunk_mode_raw in CHUNK_MODES else 'auto'

        if 'forceChunk' in data and is_owner:
            _ep_idx, _ep_name, _ep_text, _chunks = get_episode_chunks(inst_data)
            try:
                forced_chunk_id = int(data['forceChunk'])
            except (TypeError, ValueError):
                forced_chunk_id = 0
            if _chunks:
                forced_chunk_id = max(0, min(forced_chunk_id, len(_chunks) - 1))
            else:
                forced_chunk_id = 0
                
            try:
                recent_msgs = inst_data.get('messages',[])[-AI_PICKER_HISTORY_WINDOW:] if inst_data.get('messages') else []
                chunk_previews = [get_chunk_preview(c, max_length=150) for c in _chunks]
                log_entry = ChunkSelectionLog(
                    user_id=user.id,
                    instance_id=instance_id,
                    episode_index=_ep_idx,
                    recent_messages=recent_msgs,
                    available_chunks=chunk_previews,
                    selected_chunk_index=forced_chunk_id
                )
                db.session.add(log_entry)
            except Exception as e:
                app_logger.error(f"Failed to log forced chunk selection: {e}")
                
            inst_data['current_chunk_id'] = forced_chunk_id
            inst_data['max_chunk_reached'] = forced_chunk_id
            chunk_mode = 'manual'
            app_logger.info(f"Force chunk {forced_chunk_id} selected for instance {instance_id}")
        is_regen = data.get('is_regen', False) or data.get('regenerate', False)
        if is_regen and inst_data.get('messages') and inst_data['messages'][-1].get('role') in ['assistant', 'ai']:
            inst_data['messages'].pop()
            if 'forceChunk' not in data:
                last_chunk_id = 0
                found_msg = False
                for m in reversed(inst_data['messages']):
                    if m.get('role') in['assistant', 'ai'] and not found_msg:
                        if 'meta' in m:
                            if 'postTurnChunk' in m['meta']:
                                last_chunk_id = m['meta']['postTurnChunk']
                                found_msg = True
                                break
                            elif 'chunk_id' in m['meta']:
                                last_chunk_id = m['meta']['chunk_id']
                                found_msg = True
                                break
                            elif 'selectedChunk' in m['meta']:
                                last_chunk_id = m['meta']['selectedChunk']
                                found_msg = True
                                break
                if not found_msg:
                    for m in reversed(inst_data['messages']):
                        if m.get('role') == 'user' and 'meta' in m:
                            if 'chunk_id' in m['meta']:
                                last_chunk_id = m['meta']['chunk_id']
                                break
                            elif 'selectedChunk' in m['meta']:
                                last_chunk_id = m['meta']['selectedChunk']
                                break
                inst_data['current_chunk_id'] = last_chunk_id
                ep_idx, ep_name, ep_text, chunks = get_episode_chunks(inst_data)
                
                if inst_data['messages'] and inst_data['messages'][-1].get('role') == 'user':
                    if 'meta' not in inst_data['messages'][-1]:
                        inst_data['messages'][-1]['meta'] = {}
                    inst_data['messages'][-1]['meta']['chunk_id'] = last_chunk_id
                inst_data.setdefault('transcript_progress', {})['chunkIndex'] = inst_data['current_chunk_id']
                inst_data['max_chunk_reached'] = inst_data['current_chunk_id']

        if user.should_reset_credits():
            user.reset_credits()
            db.session.commit()

        now = get_utc_now()
        updated = User.query.filter(
            User.id == user.id,
            (User.generation_locked_until == None) | (User.generation_locked_until <= now)
        ).update({'generation_locked_until': now + timedelta(seconds=30)}, synchronize_session=False)
        db.session.commit()
        
        if not updated:
            return jsonify({"error": "Please wait for your current response to finish."}), 429
            
        user = current_user()
        if user.credits < 1.0:
            user.generation_locked_until = None
            db.session.commit()
            return jsonify({"error": "Insufficient credits.", "code": "insufficient_credits", "credits_remaining": math.floor(user.credits), "credits_required": 1.0, "upgrade_prompt": True}), 402

        can_cancel, cancel_remaining, cancel_retry_after = cancellation_tracker.can_cancel(user.id)
        if user_input:
            should_append = True
            if (inst_data.get('messages') and inst_data['messages'][-1].get('role') == 'user' and inst_data['messages'][-1].get('content', '').strip() == user_input.strip()):
                should_append = False
            if should_append:
                inst_data.setdefault('messages',[]).append({
                    "id": generate_unique_id("msg_"),
                    "role": "user",
                    "content": user_input
                })

        if user.subscription_tier == "Basic" and not evaluate_only:
            user.record_plus_trial_day()
            db.session.commit()
            track_trial_day(user.id, user.plus_trial_days_used)

        total_usd_cost = 0.0
        user_id = user.id
        effective_api_key = get_effective_api_key_for_user(user)

        prompt_msgs, prompt_meta = build_prompt_chain(inst_data, user, target_model=model, chunk_mode=chunk_mode)
        
        total_usd_cost += prompt_meta.get('preFlightCost', 0.0)

        prompt_hash = get_prompt_hash(prompt_msgs)

        if evaluate_only:
            user.generation_locked_until = None
            db.session.commit()
            return jsonify({"meta": prompt_meta})

        if not effective_api_key:
            user.generation_locked_until = None
            db.session.commit()
            return jsonify({"error": "No API key configured. Verify your phone number to unlock free credits.", "code": "missing_api_key"}), 400

        inst.data = inst_data
        save_model_data(inst)

        config = user.get_effective_tier_config()
        priority = config.get("priority_processing", False)

        def generate():
            nonlocal total_usd_cost
            full_response      = ""
            full_reasoning     = ""
            error_occurred     = False
            disconnected       = False
            generation_id      = None
            stream_cost        = None
            ai_selected_chunk_id  = None
            ai_picker_reason      = ""
            ai_picker_cost_usd    = 0.0

            current_cancel_status = cancellation_tracker.get_status(user_id)
            meta_payload = {
                'episodeIndex':          prompt_meta.get('episodeIndex', 0),
                'episodeName':           prompt_meta.get('episodeName', ''),
                'mode':                  prompt_meta.get('mode', 'auto'),
                'cancellationsRemaining': current_cancel_status['cancellations_remaining'],
                'canCancel':             current_cancel_status['cancellations_remaining'] > 0,
                'cancellationStatus':    current_cancel_status,
                'chunk_id':              prompt_meta.get('chunkIndex', 0),
            }
            if 'chunkIndex' in prompt_meta:
                meta_payload['selectedChunk']    = prompt_meta['chunkIndex']
                meta_payload['totalChunks']      = prompt_meta.get('chunkCount', 0)
                meta_payload['selectionReason']  = prompt_meta.get('selectionReason', '')

            try:
                yield f"data: {json.dumps({'meta': meta_payload})}\n\n"
                
                processed_chunks = []
                
                for loop_iteration in range(15):
                    if loop_iteration > 0:
                        prompt_msgs, prompt_meta = build_prompt_chain(inst_data, user, target_model=model, chunk_mode=chunk_mode)
                        total_usd_cost += prompt_meta.get('preFlightCost', 0.0)                
                    
                    if len(processed_chunks) > 0:
                        system_msg = prompt_msgs[0]['content']
                        combined_scene_text = "\n\n".join([f"[Scene {idx+1}]\n{prompt_meta['chunks'][idx]}" for idx in processed_chunks + [inst_data['current_chunk_id']]])
                        system_msg = re.sub(r'<current_scene>.*?</current_scene>', f'<current_scene>\n{combined_scene_text}\n</current_scene>', system_msg, flags=re.DOTALL)
                        prompt_msgs[0]['content'] = system_msg

                    if full_response:
                        prompt_msgs.append({"role": "assistant", "content": full_response})

                    buffer = ""
                    yielded_len = 0
                    chunk_completed = False

                    try:
                        for token in stream_openrouter(prompt_msgs, model, effective_api_key, priority=priority):
                            if isinstance(token, dict):
                                if "__generation_id__" in token:
                                    generation_id = token["__generation_id__"]
                                    continue
                                if "__stream_cost__" in token:
                                    stream_cost = token["__stream_cost__"]
                                    continue
                                if "__reasoning__" in token:
                                    reasoning_piece = token["__reasoning__"] or ""
                                    if reasoning_piece:
                                        full_reasoning += reasoning_piece
                                        yield f"data: {json.dumps({'reasoning': reasoning_piece})}\n\n"
                                    continue
                                    
                            token_text = token or ""
                            if token_text:
                                buffer += token_text
                                tag_c = "[CHUNK_COMPLETE]"
                                
                                if tag_c in buffer:
                                    chunk_completed = True
                                    parts = buffer.split(tag_c, 1)
                                    safe_text = parts[0]
                                    new_to_yield = safe_text[yielded_len:]
                                    if new_to_yield:
                                        full_response += new_to_yield
                                        yield f"data: {json.dumps({'token': new_to_yield})}\n\n"
                                        yielded_len += len(new_to_yield)
                                    break
                                else:
                                    safe_to_yield = buffer
                                    new_to_yield = buffer[yielded_len:]
                                    if new_to_yield:
                                        full_response += new_to_yield
                                        yield f"data: {json.dumps({'token': new_to_yield})}\n\n"
                                        yielded_len += len(new_to_yield)

                    except GeneratorExit:
                        disconnected = True
                        break
                    except Exception as e:
                        error_occurred = True
                        app_logger.error(f"Streaming error in /api/chat: {e}")
                        try: yield f"data: {json.dumps({'error': str(e)})}\n\n"
                        except: pass
                        break

                    if not chunk_completed:
                        new_to_yield = buffer[yielded_len:]
                        if new_to_yield:
                            full_response += new_to_yield
                            yield f"data: {json.dumps({'token': new_to_yield})}\n\n"

                    processed_chunks.append(inst_data.get('current_chunk_id', 0))

                    if chunk_completed and chunk_mode == 'auto':
                        chunks_list = prompt_meta.get('chunks',[])
                        current_idx = inst_data.get('current_chunk_id', 0)
                        
                        if current_idx < len(chunks_list) - 1:
                            next_idx = current_idx + 1
                            inst_data['current_chunk_id'] = next_idx
                            inst_data['max_chunk_reached'] = max(inst_data.get('max_chunk_reached', 0), next_idx)
                            
                            transition_data = {'from': current_idx, 'to': next_idx, 'index': next_idx, 'reason': 'Auto-navigated'}
                            yield f"data: {json.dumps({'chunk_selected': transition_data})}\n\n"
                            
                            if full_response and not full_response.endswith(("\n", " ")):
                                full_response += " "
                                yield f"data: {json.dumps({'token': ' '})}\n\n"
                            continue
                        else: break
                    else: break

            finally:
                with app.app_context():
                    try:
                        current_user_obj = db.session.get(User, user_id)
                        current_inst = db.session.get(InstanceModel, instance_id)
                        if current_user_obj:
                            final_credit_cost = 0.0
                            billing_method = "none"
                            cancellation_recorded = False
                            exceeded_cancel_limit = False
                            if disconnected:
                                can_cancel_now, _, _ = cancellation_tracker.can_cancel(user_id)
                                if can_cancel_now:
                                    success, remaining_after = cancellation_tracker.record_cancellation(user_id)
                                    if success:
                                        final_credit_cost = CANCELLATION_CREDIT_COST
                                        billing_method = "cancellation_fee"
                                        cancellation_recorded = True
                                        meta_payload['cancellationsRemaining'] = remaining_after
                                        meta_payload['canCancel'] = remaining_after > 0
                                    else:
                                        final_credit_cost = CANCELLATION_CREDIT_COST
                                        billing_method = "cancellation_fee_fallback"
                                else:
                                    exceeded_cancel_limit = True
                                    billing_method = "cancel_limit_exceeded_penalty"
                                    final_credit_cost = 5.0
                                    if generation_id and effective_api_key:
                                        cost_info = get_generation_cost(generation_id, effective_api_key)
                                        if cost_info["success"]:
                                            accurate_cost_usd = cost_info["total_cost"]
                                            generation_credit_cost = usd_to_credits(accurate_cost_usd)
                                            min_cost = float(get_model_min_cost(model))
                                            generation_billed_credits = max(generation_credit_cost, min_cost)
                                            total_for_billing = generation_billed_credits + usd_to_credits(total_usd_cost)
                                            final_credit_cost = max(total_for_billing, 5.0)
                                            billing_method = "cancel_limit_exceeded_full"
                                    meta_payload['cancelLimitExceeded'] = True
                                    meta_payload['canCancel'] = False
                            elif not error_occurred:
                                accurate_cost_usd = 0.0
                                if generation_id and effective_api_key:
                                    cost_info = get_generation_cost(generation_id, effective_api_key)
                                    if cost_info["success"]:
                                        accurate_cost_usd = cost_info["total_cost"]
                                        billing_method = "generation_api"
                                    elif stream_cost is not None:
                                        accurate_cost_usd = stream_cost
                                        billing_method = "stream_cost"
                                    else:
                                        billing_method = "fallback_unknown"
                                elif stream_cost is not None:
                                    accurate_cost_usd = stream_cost
                                    billing_method = "stream_cost"
                                else:
                                    billing_method = "fallback_unknown"
                                generation_credit_cost = usd_to_credits(accurate_cost_usd)
                                min_cost = float(get_model_min_cost(model))
                                generation_billed_credits = max(generation_credit_cost, min_cost)
                                final_credit_cost = generation_billed_credits + usd_to_credits(total_usd_cost)

                            displayed_credit_cost = math.floor(final_credit_cost)
                            current_data = dict(current_inst.data) if current_inst else None
                            if (current_inst and current_data is not None and (full_response.strip() or full_reasoning.strip())):
                                if disconnected:
                                    full_response += " [STOPPED]"
                                msg_meta = {
                                    **meta_payload,
                                    "billingMethod": billing_method,
                                    "generationId": generation_id,
                                    "postTurnChunk": inst_data.get('current_chunk_id', 0),
                                    "creditsUsed": displayed_credit_cost,
                                }

                                current_data.setdefault('messages',[]).append({
                                    "id": generate_unique_id("msg_"),
                                    "role": "assistant",
                                    "content": full_response,
                                    "reasoning": full_reasoning,
                                    "partial": disconnected,
                                    "prompt_hash": prompt_hash,
                                    "meta": msg_meta,
                                })
                                if (prompt_meta.get('mode') in ('auto', 'manual') and 'chunkIndex' in prompt_meta):
                                    chunks_list = prompt_meta.get('chunks',[])
                                    try:
                                        record_chunk_played(current_data, prompt_meta.get('episodeIndex', 0), prompt_meta['chunkIndex'], chunks_list, current_user_obj)

                                        new_chunk_id = inst_data.get('current_chunk_id', prompt_meta.get('chunkIndex', 0))
                                        
                                        current_data['current_chunk_id'] = new_chunk_id
                                        current_data.setdefault('transcript_progress', {})['chunkIndex'] = new_chunk_id
                                        current_data['messages'][-1]['meta']['postTurnChunk'] = new_chunk_id
                                        
                                        if new_chunk_id > current_data.get('max_chunk_reached', 0):
                                            current_data['max_chunk_reached'] = new_chunk_id
                                    except Exception as chunk_err:
                                        app_logger.error(f"Chunk state save failed: {chunk_err}")
                                additional_cost_usd = update_rolling_summary(current_data, current_user_obj)
                                if additional_cost_usd > 0:
                                    final_credit_cost += usd_to_credits(additional_cost_usd)
                                    displayed_credit_cost = math.floor(final_credit_cost)
                                    current_data['messages'][-1]['meta']['creditsUsed'] = displayed_credit_cost
                                current_data['lastPlayed'] = get_utc_now().isoformat()
                                current_inst.data = current_data
                                flag_modified(current_inst, "data")
                                combined_content = full_response
                                if full_reasoning.strip():
                                    combined_content = f"<think>\n{full_reasoning.strip()}\n</think>\n\n{full_response}"
                                log_finetuning_data(prompt_msgs, combined_content, prompt_hash)
                            if final_credit_cost > 0:
                                current_user_obj.deduct_credit(final_credit_cost)
                                track_credit_usage(user_id, final_credit_cost, current_user_obj.credits, current_user_obj.subscription_tier)
                            current_user_obj.last_active_at = get_utc_now()
                            current_user_obj.update_content_expiry()
                            db.session.commit()
                            if disconnected and not exceeded_cancel_limit:
                                event_type = "chat_cancelled"
                            elif disconnected and exceeded_cancel_limit:
                                event_type = "chat_cancelled_penalized"
                            elif error_occurred:
                                event_type = "chat_error"
                            else:
                                event_type = "chat_completed"
                            track_event(event_type, user_id=user_id, to_tier=current_user_obj.subscription_tier, credits_used=final_credit_cost, disconnected=disconnected, exceeded_cancel_limit=exceeded_cancel_limit, had_output=bool(full_response.strip() or full_reasoning.strip()), billing_method=billing_method, generation_id=generation_id, cancellation_recorded=cancellation_recorded, chunk_mode=chunk_mode, ai_picker_used=False)
                            meta_payload['creditsUsed'] = displayed_credit_cost
                            meta_payload['creditsRemaining'] = math.floor(current_user_obj.credits)
                            meta_payload['wasDisconnected'] = disconnected
                            meta_payload['billingMethod'] = billing_method
                            meta_payload['generationId'] = generation_id
                            cancel_status = cancellation_tracker.get_status(user_id)
                            meta_payload['cancellationStatus'] = cancel_status
                            meta_payload['canCancel'] = cancel_status['cancellations_remaining'] > 0

                            meta_payload['done'] = True
                            meta_payload['fullResponse'] = full_response
                            if full_reasoning.strip():
                                meta_payload['fullReasoning'] = full_reasoning
                            if current_data and current_data.get('messages'):
                                last_saved = current_data['messages'][-1] if current_data['messages'] else None
                                if last_saved:
                                    meta_payload['savedMessageId'] = last_saved.get('id')

                            current_user_obj.generation_locked_until = None
                            db.session.commit()

                    except Exception as e:
                        db.session.rollback()
                        app_logger.error(f"Error in chat finally block: {e}")
                if not disconnected:
                    try:
                        yield f"data: {json.dumps({'meta': meta_payload})}\n\n"
                    except Exception:
                        pass
        return Response(generate(), mimetype='text/event-stream', headers={'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'no'})
    except Exception as e:
        app_logger.error(f"Chat route error: {e}", exc_info=True)
        # Failsafe: Ensure user is unlocked if any unexpected error occurs before streaming starts.
        if 'user' in locals() and user:
            try:
                user_to_unlock = db.session.get(User, user.id)
                if user_to_unlock:
                    user_to_unlock.generation_locked_until = None
                    db.session.commit()
            except Exception as unlock_e:
                pass
        return jsonify({"error": str(e)}), 500

@app.route('/api/cancellation-status', methods=['GET'])
@jwt_required()
def get_cancellation_status():
    user = current_user()
    if not user:
        return jsonify({"error": "User not found"}), 404
    return jsonify(cancellation_tracker.get_status(user.id))

@app.route('/api/settings', methods=['GET', 'PUT'])
@jwt_required()
@rate_limit("default")
def handle_settings():
    user = current_user()
    if not user:
        return jsonify({"error": "User not found"}), 404
    if request.method == 'GET':
        models = load_models_config()
        config = user.get_effective_tier_config()
        return jsonify({"model": user.chat_model, "chunk_model": user.chunk_model, "available_models": models, "auto_summaries_enabled": config.get("auto_summaries", False), "chunk_selection_mode": user.chunk_selection_mode or "auto"})
    data = parse_json_body()
    if 'model' in data:
        allowed = {m["id"] for m in DEFAULT_MODELS}
        val = str(data['model']).strip()
        if val in allowed:
            user.chat_model = val
    if 'chunk_model' in data:
        allowed = {m["id"] for m in DEFAULT_MODELS}
        val = str(data['chunk_model']).strip()
        if val in allowed:
            user.chunk_model = val
    if 'chunk_selection_mode' in data:
        val = str(data['chunk_selection_mode']).strip().lower()
        if val in CHUNK_MODES:
            user.chunk_selection_mode = val
    db.session.commit()
    return jsonify({"success": True})

@app.route('/api/admin/stats', methods=['GET'])
@jwt_required()
@require_admin
def admin_stats():
    now = get_utc_now()
    thirty_days_ago = now - timedelta(days=30)
    seven_days_ago = now - timedelta(days=7)
    one_day_ago = now - timedelta(days=1)
    users_count = User.query.count() or 0
    safe_users_count = max(users_count, 1)
    shows_count = ShowModel.query.count()
    instances_count = InstanceModel.query.count()
    pending_cleanup = User.query.filter(User.pending_deletion_at != None, User.pending_deletion_at <= now).count()
    dau = User.query.filter(User.last_active_at >= one_day_ago).count()
    mau = User.query.filter(User.last_active_at >= thirty_days_ago).count()
    avg_credits = db.session.query(func.avg(User.credits)).scalar() or 0.0
    tier_counts = db.session.query(User.subscription_tier, func.count(User.id)).group_by(User.subscription_tier).all()
    tier_distribution = {t: 0 for t in ['Free', 'Basic', 'Plus', 'Pro']}
    paid_users = 0
    mrr = 0.0
    tier_prices = {"Basic": 7.99, "Plus": 19.99, "Pro": 34.99}
    for tier, count in tier_counts:
        if tier in tier_distribution:
            tier_distribution[tier] = count
        if tier != 'Free':
            paid_users += count
            mrr += (tier_prices.get(tier, 0) * count)
    upgrade_percentage = round((paid_users / safe_users_count) * 100, 1)
    recent_events = AnalyticsEvent.query.filter(AnalyticsEvent.created_at >= thirty_days_ago).all()
    upgrades_30d = downgrades_30d = cancellations_30d = 0
    total_chats = AnalyticsEvent.query.filter_by(event_type='chat_completed').count()
    signups_by_date = {(now - timedelta(days=i)).strftime('%Y-%m-%d'): 0 for i in range(6, -1, -1)}
    credits_by_date = {(now - timedelta(days=i)).strftime('%Y-%m-%d'): 0.0 for i in range(6, -1, -1)}
    for ev in recent_events:
        if ev.event_type == 'upgrade': upgrades_30d += 1
        elif ev.event_type == 'downgrade': downgrades_30d += 1
        elif ev.event_type == 'chat_cancelled': cancellations_30d += 1
        if ev.created_at:
            ev_date = ev.created_at.strftime('%Y-%m-%d')
            if ev.created_at >= seven_days_ago:
                if ev.event_type == 'signup' and ev_date in signups_by_date:
                    signups_by_date[ev_date] += 1
                elif ev.event_type == 'credit_used' and ev.event_data and ev_date in credits_by_date:
                    credits_by_date[ev_date] += ev.event_data.get('credits_used', 0)
    return jsonify({"users": users_count, "shows": shows_count, "instances": instances_count, "pending_cleanup": pending_cleanup, "dau": dau, "mau": mau, "mrr": round(mrr, 2), "tier_distribution": tier_distribution, "upgrade_percentage": upgrade_percentage, "total_chats": total_chats, "cancellations_30d": cancellations_30d, "avg_credits": round(avg_credits, 1), "upgrades_30d": upgrades_30d, "downgrades_30d": downgrades_30d, "signups_7d":[{"date": k, "count": v} for k, v in signups_by_date.items()], "credits_used_7d":[{"date": k, "count": round(v, 1)} for k, v in credits_by_date.items()]})

@app.route('/api/models', methods=['GET'])
@jwt_required()
def get_models():
    return jsonify(load_models_config())

@app.route('/api/credits', methods=['GET'])
@jwt_required()
def get_credits():
    user = current_user()
    if not user:
        return jsonify({"error": "User not found"}), 404
    if user.should_reset_credits():
        user.reset_credits()
        db.session.commit()
    cancel_status = cancellation_tracker.get_status(user.id)
    return jsonify({"credits": math.floor(user.credits), "credits_total": math.floor(user.get_display_credit_total()), "credits_reset_at": (user.credits_reset_at.isoformat() + "Z" if user.credits_reset_at else None), "tier": user.subscription_tier, "addon": user.credit_addon, "credits_per_hour": 75, "estimated_hours_remaining": round(math.floor(user.credits) / 75, 1), "cancellation_status": cancel_status})

@app.route('/api/content/status', methods=['GET'])
@jwt_required()
def get_content_status():
    user = current_user()
    if not user:
        return jsonify({"error": "User not found"}), 404
    return jsonify(check_content_expiration(user))

@app.route('/api/content/recover', methods=['POST'])
@jwt_required()
def recover_content():
    user = current_user()
    if not user:
        return jsonify({"error": "User not found"}), 404
    restore_user_content(user)
    return jsonify({"success": True})

@app.route('/api/admin/run-cleanup', methods=['POST'])
@jwt_required()
@require_admin
def admin_run_cleanup():
    if not request.is_json:
        return jsonify({"error": "JSON request required to prevent CSRF"}), 400
    return jsonify({"success": True, "results": process_content_cleanup()})

@app.route('/api/health', methods=['GET'])
def health():
    return jsonify({
        "status": "ok", "version": "1",
        "smtp_configured": bool(SMTP_USER and SMTP_PASS),
        "google_auth_configured": bool(GOOGLE_CLIENT_ID),
        "server_api_key_configured": bool(SERVER_API_KEY),
        "billing_method": "openrouter_generation_api",
        "cancellation_fee": CANCELLATION_CREDIT_COST,
        "max_cancellations_per_hour": MAX_CANCELLATIONS_PER_HOUR,
        "episode_modes": ["auto", "manual", "ai_picker"],
        "chunk_system":  "v4_ai_picker",
    })

def check_instance_limit(user):
    config = user.get_effective_tier_config()
    max_instances = config["max_instances"]
    current_count = InstanceModel.query.filter_by(user_id=user.id, is_archived=False).count()
    return current_count < max_instances, current_count, max_instances

def start_background_cleanup(app_instance):
    def run_schedule():
        sleep_interval = 10800
        while True:
            time.sleep(sleep_interval)
            with app_instance.app_context():
                try:
                    app_logger.info("Running automatic 3-hour content cleanup...")
                    results = process_content_cleanup()
                    app_logger.info(f"Automatic cleanup completed: {results}")
                except Exception as e:
                    app_logger.error(f"Automatic cleanup failed: {e}")
    thread = threading.Thread(target=run_schedule, daemon=True)
    thread.start()

if __name__ == '__main__':
    with app.app_context():
        db.create_all()
        run_migrations()
        initialize_free_tier_rollout()
        load_models_config()
        print("🚀 Roleplay Terminal Web v1")
        print(f" SMTP: {'Configured' if SMTP_USER else 'Mock mode (OTP logs to console)'}")
        print(f" Billing: OpenRouter Generation API")
        print(f" Episode modes: auto | manual")
        print(f" Cancellation: {CANCELLATION_CREDIT_COST} credit fee, max {MAX_CANCELLATIONS_PER_HOUR}/hour")
    start_background_cleanup(app)
    app.run(host='0.0.0.0', port=6328, debug=False, threaded=True, use_reloader=False)
