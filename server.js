"use strict";

require("dotenv").config();

const express = require("express");
const path = require("path");
const crypto = require("crypto");

const app = express();

const PORT =
    Number(process.env.PORT) || 2307;

const PROJECT_ID =
    String(process.env.PROJECT_ID || "1374729902").trim();

const PROJECT_OWNER =
    String(process.env.PROJECT_OWNER || "mahiro0622").trim();

const CLOUD_VARIABLE =
    String(
        process.env.CLOUD_VARIABLE || "auth_code"
    ).trim();

const CODE_EXPIRE_SECONDS =
    Number(
        process.env.CODE_EXPIRE_SECONDS
    ) || 600;

const CLOUD_LOG_LIMIT =
    Math.min(
        Number(process.env.CLOUD_LOG_LIMIT) || 100,
        100
    );

const ADMIN_KEY =
    String(process.env.ADMIN_KEY || "").trim();

const WEBHOOK_URL =
    String(process.env.WEBHOOK_URL || "").trim();

const PUBLIC_DIR =
    path.join(__dirname, "public");


/* =====================================================
   設定確認
===================================================== */

if (!PROJECT_ID) {
    console.error(
        "PROJECT_ID が設定されていません。"
    );

    process.exit(1);
}

if (!PROJECT_OWNER) {
    console.error(
        "PROJECT_OWNER が設定されていません。"
    );

    process.exit(1);
}


/* =====================================================
   Express
===================================================== */

app.disable("x-powered-by");

app.use(
    express.json({
        limit: "20kb"
    })
);

app.use(
    express.static(PUBLIC_DIR)
);


/* =====================================================
   認証コード
===================================================== */

const pendingAuth =
    new Map();


/*
    username ->

    {
        username,
        userId,
        code,
        createdAt,
        expiresAt,
        method
    }
*/


/* =====================================================
   セッション
===================================================== */

const sessions =
    new Map();


/* =====================================================
   最近処理したCloud Log
===================================================== */

const processedCloudLogs =
    new Set();


/* =====================================================
   レートリミット
===================================================== */

const rateLimitStore =
    new Map();


/*
    setInterval で期限切れエントリを削除
*/

setInterval(
    () => {

        const now =
            Date.now();


        for (
            const [
                key,
                record
            ] of rateLimitStore
        ) {

            if (now > record.resetAt) {

                rateLimitStore.delete(
                    key
                );
            }
        }
    },
    60000
);


function checkRateLimit(
    key,
    maxRequests,
    windowMs
) {

    const now =
        Date.now();


    let record =
        rateLimitStore.get(key);


    if (
        !record ||
        now > record.resetAt
    ) {

        record = {
            count: 1,
            resetAt: now + windowMs
        };

        rateLimitStore.set(
            key,
            record
        );

        return {
            allowed: true,
            remaining: maxRequests - 1
        };
    }


    if (record.count >= maxRequests) {

        return {
            allowed: false,
            remaining: 0,
            retryAfter:
                Math.ceil(
                    (record.resetAt - now) /
                    1000
                )
        };
    }


    record.count++;

    return {
        allowed: true,
        remaining:
            maxRequests -
            record.count
    };
}


function getClientIp(req) {

    return (
        String(
            req.headers["x-forwarded-for"] ||
            ""
        ).split(",")[0].trim() ||

        req.socket?.remoteAddress ||

        "unknown"
    );
}


/* =====================================================
   認証ログ
===================================================== */

const authLog =
    [];

const AUTH_LOG_MAX =
    200;


function addAuthLog(entry) {

    authLog.unshift({
        ...entry,
        timestamp: Date.now()
    });


    if (authLog.length > AUTH_LOG_MAX) {

        authLog.splice(AUTH_LOG_MAX);
    }
}


/* =====================================================
   Webhook
===================================================== */

async function fireWebhook(payload) {

    if (!WEBHOOK_URL) {
        return;
    }


    try {

        await fetch(
            WEBHOOK_URL,
            {
                method: "POST",

                headers: {
                    "Content-Type":
                        "application/json",

                    "User-Agent":
                        "Scratch-Auth-Ultra/3.0"
                },

                body:
                    JSON.stringify(payload)
            }
        );

    } catch (error) {

        console.error(
            "[WEBHOOK]",
            error.message
        );
    }
}


/* =====================================================
   ユーティリティ
===================================================== */

function normalizeUsername(
    username
) {

    return String(username || "")
        .trim()
        .toLowerCase();
}


function normalizeVariableName(
    name
) {

    let value =
        String(name || "").trim();

    if (!value.startsWith("☁")) {
        value = "☁ " + value;
    }

    return value;
}


function generateCode() {

    /*
        数字だけにする。

        Scratchのクラウド変数は
        数字を扱いやすいため、
        12桁の認証コードにする。
    */

    let code = "";

    for (let i = 0; i < 12; i++) {

        code +=
            crypto
                .randomInt(0, 10)
                .toString();
    }

    return code;
}


function generateSessionToken() {

    return crypto
        .randomBytes(32)
        .toString("hex");
}


function isValidUsername(
    username
) {

    if (!username) {
        return false;
    }

    if (username.length > 50) {
        return false;
    }

    return /^[A-Za-z0-9_-]+$/.test(
        username
    );
}


/* =====================================================
   Scratch User API
===================================================== */

async function getScratchUser(
    username
) {

    const url =
        "https://api.scratch.mit.edu/users/" +
        encodeURIComponent(username);


    const response =
        await fetch(
            url,
            {
                headers: {
                    "Accept":
                        "application/json",

                    "User-Agent":
                        "Scratch-Auth-Ultra/3.0"
                }
            }
        );


    if (
        response.status === 404
    ) {

        return null;
    }


    if (!response.ok) {

        throw new Error(
            `Scratch User API Error: ${response.status}`
        );
    }


    return await response.json();
}


/* =====================================================
   Scratch Project API
===================================================== */

async function getProject() {

    const url =
        "https://api.scratch.mit.edu/projects/" +
        encodeURIComponent(PROJECT_ID);


    const response =
        await fetch(
            url,
            {
                headers: {
                    "Accept":
                        "application/json",

                    "User-Agent":
                        "Scratch-Auth-Ultra/3.0"
                }
            }
        );


    if (!response.ok) {

        throw new Error(
            `Scratch Project API Error: ${response.status}`
        );
    }


    return await response.json();
}


/* =====================================================
   Project Comments
===================================================== */

async function getProjectComments() {

    const allComments = [];

    const LIMIT = 40;

    const MAX_PAGES = 5;


    for (
        let page = 0;
        page < MAX_PAGES;
        page++
    ) {

        const offset =
            page * LIMIT;


        const url =
            "https://api.scratch.mit.edu/users/" +
            encodeURIComponent(PROJECT_OWNER) +
            "/projects/" +
            encodeURIComponent(PROJECT_ID) +
            "/comments" +
            `?limit=${LIMIT}&offset=${offset}`;


        const response =
            await fetch(
                url,
                {
                    headers: {
                        "Accept":
                            "application/json",

                        "User-Agent":
                            "Scratch-Auth-Ultra/3.0"
                    }
                }
            );


        if (!response.ok) {

            throw new Error(
                `Scratch Comment API Error: ${response.status}`
            );
        }


        const comments =
            await response.json();


        if (
            !Array.isArray(comments)
        ) {
            break;
        }


        allComments.push(
            ...comments
        );


        if (
            comments.length < LIMIT
        ) {
            break;
        }
    }


    return allComments;
}


/* =====================================================
   Comment認証
===================================================== */

async function checkCommentAuth(
    username,
    code
) {

    const comments =
        await getProjectComments();


    const targetUser =
        normalizeUsername(
            username
        );


    for (
        const comment of comments
    ) {

        const author =
            comment?.author?.username ||
            "";


        const content =
            String(
                comment?.content || ""
            ).trim();


        if (
            normalizeUsername(author)
            !== targetUser
        ) {
            continue;
        }


        if (
            content !== code
        ) {
            continue;
        }


        return {

            found: true,

            username: author,

            commentId:
                comment.id || null,

            content
        };
    }


    return {
        found: false
    };
}


/* =====================================================
   Cloud Logs
===================================================== */

async function getCloudLogs() {

    const url =
        "https://clouddata.scratch.mit.edu/logs" +
        `?projectid=${encodeURIComponent(PROJECT_ID)}` +
        `&limit=${CLOUD_LOG_LIMIT}` +
        "&offset=0";


    const response =
        await fetch(
            url,
            {
                headers: {
                    "Accept":
                        "application/json",

                    "User-Agent":
                        "Scratch-Auth-Ultra/3.0"
                }
            }
        );


    if (!response.ok) {

        throw new Error(
            `Scratch Cloud Log Error: ${response.status}`
        );
    }


    const data =
        await response.json();


    return Array.isArray(data)
        ? data
        : [];
}


/* =====================================================
   Cloud Variable認証
===================================================== */

async function checkCloudAuth(
    username,
    code
) {

    const logs =
        await getCloudLogs();


    const targetUser =
        normalizeUsername(
            username
        );


    const targetVariable =
        normalizeVariableName(
            CLOUD_VARIABLE
        );


    /*
        最新ログから検索
    */

    for (
        const log of logs
    ) {

        /*
            API形式の違いに対応
        */

        const logUser =
            log.user ||
            log.username ||
            "";


        const logName =
            log.name ||
            "";


        const logValue =
            String(
                log.value ?? ""
            ).trim();


        /*
            変数名確認
        */

        if (
            normalizeVariableName(logName)
            !== targetVariable
        ) {
            continue;
        }


        /*
            ユーザー名確認
        */

        if (
            normalizeUsername(logUser)
            !== targetUser
        ) {
            continue;
        }


        /*
            コード確認
        */

        if (
            logValue !== code
        ) {
            continue;
        }


        /*
            Log ID生成
        */

        const logId =
            [
                log.timestamp || "",
                log.user || "",
                log.name || "",
                log.value || ""
            ].join("|");


        return {

            found: true,

            username:
                logUser,

            value:
                logValue,

            variable:
                logName,

            timestamp:
                log.timestamp || null,

            logId
        };
    }


    return {
        found: false
    };
}


/* =====================================================
   Expired cleanup
===================================================== */

function cleanupExpiredAuth() {

    const now =
        Date.now();


    for (
        const [
            username,
            auth
        ] of pendingAuth
    ) {

        if (
            auth.expiresAt <= now
        ) {

            pendingAuth.delete(
                username
            );
        }
    }
}


setInterval(
    cleanupExpiredAuth,
    30000
);


/* =====================================================
   Cloud log cache cleanup
===================================================== */

setInterval(
    () => {

        if (
            processedCloudLogs.size >
            5000
        ) {

            processedCloudLogs.clear();
        }

    },
    60000
);


/* =====================================================
   Health
===================================================== */

app.get(
    "/api/health",
    (req, res) => {

        res.json({

            success: true,

            status:
                "online",

            service:
                "Scratch Auth Ultra",

            projectId:
                PROJECT_ID,

            cloudVariable:
                normalizeVariableName(
                    CLOUD_VARIABLE
                ),

            timestamp:
                new Date().toISOString()
        });
    }
);


/* =====================================================
   Project
===================================================== */

app.get(
    "/api/project",
    async (req, res) => {

        try {

            const project =
                await getProject();


            res.json({

                success: true,

                project: {

                    id:
                        project.id,

                    title:
                        project.title,

                    author:
                        project.author?.username ||
                        PROJECT_OWNER,

                    thumbnail:
                        `https://uploads.scratch.mit.edu/projects/thumbnails/${PROJECT_ID}.png`,

                    url:
                        `https://scratch.mit.edu/projects/${PROJECT_ID}/`
                }
            });


        } catch (error) {

            console.error(
                "[PROJECT]",
                error
            );


            res.status(500).json({

                success: false,

                message:
                    "プロジェクト情報を取得できませんでした。"
            });
        }
    }
);


/* =====================================================
   Scratch User Profile
===================================================== */

app.get(
    "/api/scratch/user/:username",
    async (req, res) => {

        try {

            const username =
                String(
                    req.params.username
                );


            const user =
                await getScratchUser(
                    username
                );


            if (!user) {

                return res.status(404).json({

                    success: false,

                    message:
                        "ユーザーが見つかりません。"
                });
            }


            res.json({

                success: true,

                user
            });


        } catch (error) {

            console.error(
                "[USER]",
                error
            );


            res.status(500).json({

                success: false,

                message:
                    "ユーザー情報を取得できませんでした。"
            });
        }
    }
);


/* =====================================================
   Authentication Start
===================================================== */

app.post(
    "/api/auth/start",
    async (req, res) => {

        try {

            /* =========================================
               Rate Limit — IP別 10回/分
            ========================================= */

            const ip =
                getClientIp(req);


            const rl =
                checkRateLimit(
                    "start:" + ip,
                    10,
                    60000
                );


            if (!rl.allowed) {

                return res.status(429).json({

                    success: false,

                    error:
                        "RATE_LIMITED",

                    message:
                        `リクエストが多すぎます。` +
                        `${rl.retryAfter}秒後に再試行してください。`,

                    retryAfter:
                        rl.retryAfter
                });
            }


            const username =
                String(
                    req.body?.username || ""
                ).trim();


            const method =
                req.body?.method === "cloud"
                    ? "cloud"
                    : "comment";


            if (
                !isValidUsername(
                    username
                )
            ) {

                return res.status(400).json({

                    success: false,

                    error:
                        "INVALID_USERNAME",

                    message:
                        "Scratchユーザー名が正しくありません。"
                });
            }


            const user =
                await getScratchUser(
                    username
                );


            if (!user) {

                return res.status(404).json({

                    success: false,

                    error:
                        "USER_NOT_FOUND",

                    message:
                        "Scratchユーザーが見つかりません。"
                });
            }


            const code =
                generateCode();


            const createdAt =
                Date.now();


            const expiresAt =
                createdAt +
                CODE_EXPIRE_SECONDS * 1000;


            const key =
                normalizeUsername(
                    username
                );


            pendingAuth.set(
                key,
                {

                    username:
                        user.username,

                    userId:
                        user.id,

                    code,

                    method,

                    createdAt,

                    expiresAt
                }
            );


            const projectUrl =
                `https://scratch.mit.edu/projects/${PROJECT_ID}/`;


            res.json({

                success: true,

                username:
                    user.username,

                userId:
                    user.id,

                method,

                code,

                expiresAt,

                expiresIn:
                    CODE_EXPIRE_SECONDS,

                projectId:
                    PROJECT_ID,

                projectUrl,

                cloudVariable:
                    normalizeVariableName(
                        CLOUD_VARIABLE
                    ),

                message:
                    method === "cloud"
                        ? "クラウド変数にコードを設定してください。"
                        : "Scratchプロジェクトにコードをコメントしてください。"
            });


        } catch (error) {

            console.error(
                "[AUTH START]",
                error
            );


            res.status(500).json({

                success: false,

                error:
                    "AUTH_START_ERROR",

                message:
                    "認証を開始できませんでした。"
            });
        }
    }
);


/* =====================================================
   Authentication Check
===================================================== */

app.post(
    "/api/auth/check",
    async (req, res) => {

        try {

            /* =========================================
               Rate Limit — IP別 60回/分
            ========================================= */

            const ip =
                getClientIp(req);


            const rl =
                checkRateLimit(
                    "check:" + ip,
                    60,
                    60000
                );


            if (!rl.allowed) {

                return res.status(429).json({

                    success: false,

                    authenticated:
                        false,

                    error:
                        "RATE_LIMITED",

                    message:
                        `リクエストが多すぎます。` +
                        `${rl.retryAfter}秒後に再試行してください。`,

                    retryAfter:
                        rl.retryAfter
                });
            }


            const username =
                String(
                    req.body?.username || ""
                ).trim();


            const key =
                normalizeUsername(
                    username
                );


            const auth =
                pendingAuth.get(
                    key
                );


            if (!auth) {

                return res.status(404).json({

                    success: false,

                    authenticated:
                        false,

                    error:
                        "AUTH_NOT_FOUND",

                    message:
                        "認証コードが存在しないか、期限切れです。"
                });
            }


            if (
                Date.now() >
                auth.expiresAt
            ) {

                pendingAuth.delete(
                    key
                );


                return res.status(410).json({

                    success: false,

                    authenticated:
                        false,

                    error:
                        "AUTH_EXPIRED",

                    message:
                        "認証コードの有効期限が切れています。"
                });
            }


            let result;


            /* =========================================
               Comment
            ========================================= */

            if (
                auth.method === "comment"
            ) {

                result =
                    await checkCommentAuth(
                        auth.username,
                        auth.code
                    );
            }


            /* =========================================
               Cloud
            ========================================= */

            else {

                result =
                    await checkCloudAuth(
                        auth.username,
                        auth.code
                    );
            }


            if (
                !result.found
            ) {

                return res.json({

                    success: true,

                    authenticated:
                        false,

                    status:
                        "WAITING",

                    method:
                        auth.method,

                    message:
                        auth.method === "cloud"
                            ? "☁ クラウド変数の変更を待っています…"
                            : "💬 認証コメントを待っています…"
                });
            }


            /* =========================================
               Success
            ========================================= */

            const sessionToken =
                generateSessionToken();


            const sessionCreated =
                Date.now();


            sessions.set(
                sessionToken,
                {

                    username:
                        auth.username,

                    userId:
                        auth.userId,

                    method:
                        auth.method,

                    createdAt:
                        sessionCreated,

                    expiresAt:
                        sessionCreated +
                        24 * 60 * 60 * 1000
                }
            );


            /*
                One-time code
            */

            pendingAuth.delete(
                key
            );


            /* =========================================
               認証ログ記録
            ========================================= */

            addAuthLog({
                username:
                    auth.username,

                userId:
                    auth.userId,

                method:
                    auth.method,

                ip
            });


            /* =========================================
               Webhook 送信
            ========================================= */

            fireWebhook({
                event:
                    "auth_success",

                username:
                    auth.username,

                userId:
                    auth.userId,

                method:
                    auth.method,

                timestamp:
                    new Date().toISOString()
            });


            res.json({

                success: true,

                authenticated:
                    true,

                status:
                    "AUTHENTICATED",

                method:
                    auth.method,

                sessionToken,

                user: {

                    username:
                        auth.username,

                    id:
                        auth.userId
                },

                verification:
                    result,

                message:
                    "Scratch Authに成功しました。"
            });


        } catch (error) {

            console.error(
                "[AUTH CHECK]",
                error
            );


            res.status(500).json({

                success: false,

                authenticated:
                    false,

                error:
                    "AUTH_CHECK_ERROR",

                message:
                    "認証確認中にエラーが発生しました。"
            });
        }
    }
);


/* =====================================================
   Me
===================================================== */

app.get(
    "/api/auth/me",
    (req, res) => {

        const authorization =
            req.headers.authorization || "";


        if (
            !authorization.startsWith(
                "Bearer "
            )
        ) {

            return res.status(401).json({

                success: false,

                authenticated:
                    false
            });
        }


        const token =
            authorization.substring(7);


        const session =
            sessions.get(token);


        if (!session) {

            return res.status(401).json({

                success: false,

                authenticated:
                    false
            });
        }


        if (
            Date.now() >
            session.expiresAt
        ) {

            sessions.delete(
                token
            );


            return res.status(401).json({

                success: false,

                authenticated:
                    false,

                message:
                    "セッションの期限が切れています。"
            });
        }


        res.json({

            success: true,

            authenticated:
                true,

            user: {

                username:
                    session.username,

                id:
                    session.userId
            },

            method:
                session.method,

            expiresAt:
                session.expiresAt
        });
    }
);


/* =====================================================
   Logout
===================================================== */

app.post(
    "/api/auth/logout",
    (req, res) => {

        const authorization =
            req.headers.authorization || "";


        if (
            authorization.startsWith(
                "Bearer "
            )
        ) {

            const token =
                authorization.substring(7);


            sessions.delete(
                token
            );
        }


        res.json({

            success: true
        });
    }
);


/* =====================================================
   Admin — 認証ミドルウェア
===================================================== */

function requireAdmin(req, res, next) {

    if (!ADMIN_KEY) {

        return res.status(503).json({

            success: false,

            error:
                "ADMIN_DISABLED",

            message:
                "管理者機能が設定されていません。" +
                "ADMIN_KEY を .env に追加してください。"
        });
    }


    const authorization =
        req.headers.authorization || "";


    if (
        !authorization.startsWith("Bearer ") ||
        authorization.substring(7) !== ADMIN_KEY
    ) {

        return res.status(401).json({

            success: false,

            error:
                "UNAUTHORIZED",

            message:
                "管理者キーが正しくありません。"
        });
    }


    next();
}


/* =====================================================
   Admin — Stats
===================================================== */

app.get(
    "/api/admin/stats",
    requireAdmin,
    (req, res) => {

        const now =
            Date.now();


        /* =========================================
           Active Sessions
        ========================================= */

        const activeSessions = [];

        for (
            const [
                token,
                session
            ] of sessions
        ) {

            if (session.expiresAt > now) {

                activeSessions.push({

                    token:
                        token.substring(0, 8) +
                        "…",

                    username:
                        session.username,

                    userId:
                        session.userId,

                    method:
                        session.method,

                    createdAt:
                        session.createdAt,

                    expiresAt:
                        session.expiresAt
                });
            }
        }


        /* =========================================
           Pending Auths
        ========================================= */

        const pendingList = [];

        for (
            const [
                ,
                auth
            ] of pendingAuth
        ) {

            if (auth.expiresAt > now) {

                pendingList.push({

                    username:
                        auth.username,

                    method:
                        auth.method,

                    createdAt:
                        auth.createdAt,

                    expiresAt:
                        auth.expiresAt
                });
            }
        }


        res.json({

            success: true,

            stats: {

                activeSessions:
                    activeSessions.length,

                pendingAuths:
                    pendingList.length,

                totalAuthLogs:
                    authLog.length
            },

            sessions:
                activeSessions,

            pending:
                pendingList,

            recentAuths:
                authLog.slice(0, 100)
        });
    }
);


/* =====================================================
   Admin — Revoke Session
===================================================== */

app.delete(
    "/api/admin/sessions/:token",
    requireAdmin,
    (req, res) => {

        const prefix =
            String(
                req.params.token || ""
            ).trim();


        let revoked =
            0;


        for (
            const [token] of sessions
        ) {

            if (
                token.startsWith(prefix)
            ) {

                sessions.delete(token);

                revoked++;

                break;
            }
        }


        res.json({

            success: true,

            revoked
        });
    }
);


/* =====================================================
   SPA fallback
===================================================== */

app.use(
    (req, res) => {

        if (
            req.method === "GET" &&
            !req.path.startsWith("/api/")
        ) {

            return res.sendFile(
                path.join(
                    PUBLIC_DIR,
                    "index.html"
                )
            );
        }


        res.status(404).json({

            success: false,

            error:
                "NOT_FOUND"
        });
    }
);


/* =====================================================
   Server
===================================================== */

app.listen(
    PORT,
    () => {

        console.log("");
        console.log(
            "=========================================="
        );

        console.log(
            "       Scratch Auth Ultra 3.0"
        );

        console.log(
            "=========================================="
        );

        console.log(
            `URL: http://localhost:${PORT}`
        );

        console.log(
            `Project ID: ${PROJECT_ID}`
        );

        console.log(
            `Project Owner: ${PROJECT_OWNER}`
        );

        console.log(
            `Cloud Variable: ☁ ${CLOUD_VARIABLE}`
        );

        console.log(
            `Code Expire: ${CODE_EXPIRE_SECONDS}s`
        );

        console.log(
            `Admin Dashboard: ${
                ADMIN_KEY
                    ? "http://localhost:" + PORT + "/admin.html"
                    : "無効 (ADMIN_KEY未設定)"
            }`
        );

        console.log(
            `Webhook: ${WEBHOOK_URL || "無効 (WEBHOOK_URL未設定)"}`
        );

        console.log(
            "=========================================="
        );

        console.log("");
    }
);