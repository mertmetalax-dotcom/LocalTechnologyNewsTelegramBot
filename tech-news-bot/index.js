require("dotenv").config();

const Parser = require("rss-parser");
const axios = require("axios");
const cron = require("node-cron");
const express = require("express");
const path = require("path");
const http = require("http");

const helmet = require("helmet");
const session = require("express-session");
const bcrypt = require("bcrypt");
const rateLimit = require("express-rate-limit");
const validator = require("validator");

const { Server } = require("socket.io");

const db = require("./database");

const app = express();

const server = http.createServer(app);

const io = new Server(server);


/* =========================
   RSS PARSER
========================= */

const parser = new Parser({
    timeout: 15000
});


/* =========================
   ENV
========================= */

const BOT_TOKEN =
    process.env.BOT_TOKEN;

const PORT =
    process.env.PORT || 3000;

const ADMIN_USER =
    process.env.ADMIN_USER || "admin";

const ADMIN_PASS_HASH =
    process.env.ADMIN_PASS_HASH;


/* =========================
   SECURITY
========================= */

app.use(helmet({
    contentSecurityPolicy: false
}));

const limiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 200
});

app.use(limiter);

app.use(session({
    secret:
        process.env.SESSION_SECRET || "secret",

    resave: false,

    saveUninitialized: false,

    cookie: {
        secure: false,
        httpOnly: true,
        sameSite: "lax",
        maxAge:
            1000 * 60 * 60 * 24
    }
}));


/* =========================
   EXPRESS
========================= */

app.use(express.static("public"));

app.use(express.json());

app.use(express.urlencoded({
    extended: true
}));


/* =========================
   SYSTEM
========================= */

let isFetching = false;

let liveLogs = [];

let lastUpdateId = 0;

let lastRunTime = "-";


/* =========================
   HELPERS
========================= */

function delay(ms) {

    return new Promise(resolve => {

        setTimeout(resolve, ms);
    });
}


function addLog(message) {

    const time =
        new Date().toLocaleTimeString("tr-TR");

    const log =
        `[${time}] ${message}`;

    console.log(log);

    liveLogs.unshift(log);

    liveLogs =
        liveLogs.slice(0, 100);

    io.emit("new-log", log);
}


function cleanText(text = "") {

    return text
        .replace(/(<([^>]+)>)/gi, "")
        .replace(/\s+/g, " ")
        .trim();
}


function getSourceName(url) {

    try {

        return new URL(url)
            .hostname
            .replace("www.", "");

    } catch {

        return "RSS";
    }
}


function getNewsImage(item) {

    if (
        item.enclosure &&
        item.enclosure.url
    ) {

        return item.enclosure.url;
    }

    if (
        item["media:content"] &&
        item["media:content"].url
    ) {

        return item["media:content"].url;
    }

    return null;
}


function detectCategory(title = "") {

    const t =
        title.toLowerCase();

    if (
        t.includes("ai") ||
        t.includes("openai") ||
        t.includes("chatgpt") ||
        t.includes("gemini")
    ) {

        return "AI";
    }

    if (
        t.includes("iphone") ||
        t.includes("android") ||
        t.includes("mobile")
    ) {

        return "MOBILE";
    }

    if (
        t.includes("hack") ||
        t.includes("security") ||
        t.includes("cyber")
    ) {

        return "SECURITY";
    }

    if (
        t.includes("game") ||
        t.includes("gaming")
    ) {

        return "GAMING";
    }

    if (
        t.includes("startup")
    ) {

        return "STARTUP";
    }

    return "TECH";
}


function authMiddleware(req, res, next) {

    if (req.session.loggedIn) {

        return next();
    }

    return res.redirect("/login");
}


/* =========================
   TELEGRAM
========================= */

async function checkTelegramUpdates() {

    try {

        const response =
            await axios.get(
                `https://api.telegram.org/bot${BOT_TOKEN}/getUpdates`
            );

        const updates =
            response.data.result;

        for (const update of updates) {

            if (
                update.update_id <= lastUpdateId
            ) {

                continue;
            }

            lastUpdateId =
                update.update_id;

            if (!update.message) {

                continue;
            }

            const chatId =
                update.message.chat.id;

            const username =
                update.message.chat.username || "unknown";

            const text =
                update.message.text || "";

            db.run(
                `
                INSERT OR IGNORE INTO users (
                    chat_id,
                    username
                )
                VALUES (?, ?)
                `,
                [
                    chatId,
                    username
                ]
            );

            addLog(
                `Kullanıcı kayıt edildi: ${username}`
            );

            if (text === "/start") {

                await axios.post(
                    `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`,
                    {
                        chat_id: chatId,

                        text:
`🚀 AI News Bot aktif edildi.

Teknoloji haberleri otomatik gönderilecek.`
                    }
                );
            }
        }

    } catch (error) {

        addLog(
            "Telegram update hatası"
        );
    }
}


/* =========================
   TELEGRAM SEND
========================= */

async function sendTelegramMessage(message) {

    try {

        const users =
            await new Promise((resolve) => {

                db.all(
                    `
                    SELECT *
                    FROM users
                    `,
                    [],
                    (err, rows) => {

                        resolve(rows || []);
                    }
                );
            });

        for (const user of users) {

            try {

                await axios.post(
                    `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`,
                    {
                        chat_id: user.chat_id,

                        text: message,

                        disable_web_page_preview: false
                    }
                );

                await delay(500);

            } catch {

                addLog(
                    `Gönderim başarısız`
                );
            }
        }

    } catch {

        addLog(
            "Telegram sistemi hatası"
        );
    }
}


/* =========================
   RSS FETCH
========================= */

async function getTechNews() {

    if (isFetching) {

        addLog("RSS zaten çalışıyor");

        return;
    }

    isFetching = true;

    lastRunTime =
        new Date().toLocaleString("tr-TR");

    try {

        const feeds =
            await new Promise((resolve) => {

                db.all(
                    `
                    SELECT *
                    FROM feeds
                    WHERE active = 1
                    `,
                    [],
                    (err, rows) => {

                        resolve(rows || []);
                    }
                );
            });

        addLog(
            `${feeds.length} feed taranıyor`
        );

        for (const feed of feeds) {

            try {

                addLog(
                    `Feed taranıyor: ${feed.url}`
                );

                const feedData =
                    await parser.parseURL(feed.url);

                const latestNews =
                    feedData.items.slice(0, 5);

                for (const item of latestNews) {

                    try {

                        if (
                            !item.title ||
                            !item.link
                        ) {

                            continue;
                        }

                        const exists =
                            await new Promise((resolve) => {

                                db.get(
                                    `
                                    SELECT id
                                    FROM news
                                    WHERE link = ?
                                    `,
                                    [item.link],
                                    (err, row) => {

                                        resolve(!!row);
                                    }
                                );
                            });

                        if (exists) {

                            continue;
                        }

                        const description =
                            cleanText(
                                item.contentSnippet ||
                                item.content ||
                                item.summary ||
                                ""
                            ).slice(0, 250);

                        const source =
                            getSourceName(feed.url);

                        const image =
                            getNewsImage(item);

                        const category =
                            detectCategory(item.title);

                        const createdAt =
                            new Date()
                            .toLocaleString("tr-TR");

                        const insertedNews =
                            {
                                title: item.title,
                                link: item.link,
                                source,
                                description,
                                image,
                                category,
                                created_at: createdAt
                            };

                        await new Promise((resolve) => {

                            db.run(
                                `
                                INSERT INTO news (
                                    title,
                                    link,
                                    source,
                                    description,
                                    image,
                                    category,
                                    created_at
                                )
                                VALUES (?, ?, ?, ?, ?, ?, ?)
                                `,
                                [
                                    insertedNews.title,
                                    insertedNews.link,
                                    insertedNews.source,
                                    insertedNews.description,
                                    insertedNews.image,
                                    insertedNews.category,
                                    insertedNews.created_at
                                ],
                                () => {

                                    resolve();
                                }
                            );
                        });

                        addLog(
                            `Yeni haber: ${item.title}`
                        );

                        const message =
`📰 ${item.title}

📡 ${source}

📄 ${description}

🔗 ${item.link}`;

                        await sendTelegramMessage(message);

                        io.emit(
                            "news-added",
                            insertedNews
                        );

                        await delay(1000);

                    } catch {

                        addLog(
                            "Haber işleme hatası"
                        );
                    }
                }

            } catch {

                addLog(
                    `Feed hatası: ${feed.url}`
                );
            }
        }

    } catch {

        addLog(
            "RSS sistemi hatası"
        );

    } finally {

        isFetching = false;
    }
}


/* =========================
   LOGIN
========================= */

app.get("/login", (req, res) => {

    res.sendFile(
        path.join(
            __dirname,
            "views",
            "login.html"
        )
    );
});


app.post("/login", async (req, res) => {

    const {
        username,
        password
    } = req.body;

    if (
        username !== ADMIN_USER
    ) {

        return res.redirect("/login");
    }

    const valid =
        await bcrypt.compare(
            password,
            ADMIN_PASS_HASH
        );

    if (!valid) {

        return res.redirect("/login");
    }

    req.session.loggedIn = true;

    res.redirect("/");
});


app.get("/logout", (req, res) => {

    req.session.destroy(() => {

        res.redirect("/login");
    });
});


/* =========================
   DASHBOARD
========================= */

app.get(
    "/",
    authMiddleware,
    (req, res) => {

        res.sendFile(
            path.join(
                __dirname,
                "views",
                "dashboard.html"
            )
        );
    }
);


/* =========================
   API NEWS
========================= */

app.get(
    "/api/news",
    authMiddleware,
    (req, res) => {

        db.all(
            `
            SELECT *
            FROM news
            ORDER BY id DESC
            LIMIT 100
            `,
            [],
            (err, rows) => {

                if (err) {

                    return res.json({
                        success: false
                    });
                }

                db.all(
                    `
                    SELECT *
                    FROM feeds
                    WHERE active = 1
                    `,
                    [],
                    (err2, feeds) => {

                        res.json({

                            success: true,

                            stats: {

                                totalNews:
                                    rows.length,

                                totalSources:
                                    feeds.length,

                                lastRunTime
                            },

                            news: rows
                        });
                    }
                );
            }
        );
    }
);


/* =========================
   API LOGS
========================= */

app.get(
    "/api/logs",
    authMiddleware,
    (req, res) => {

        res.json(liveLogs);
    }
);


/* =========================
   API FEEDS
========================= */

app.get(
    "/api/feeds",
    authMiddleware,
    (req, res) => {

        db.all(
            `
            SELECT *
            FROM feeds
            ORDER BY id DESC
            `,
            [],
            (err, rows) => {

                res.json(rows || []);
            }
        );
    }
);


/* =========================
   ADD FEED
========================= */

app.post(
    "/api/feeds",
    authMiddleware,
    (req, res) => {

        const { url } = req.body;

        if (
            !url ||
            !validator.isURL(url)
        ) {

            return res.json({
                success: false
            });
        }

        db.get(
            `
            SELECT id
            FROM feeds
            WHERE url = ?
            `,
            [url],
            (err, existing) => {

                if (existing) {

                    return res.json({
                        success: false
                    });
                }

                db.run(
                    `
                    INSERT INTO feeds (
                        url,
                        active
                    )
                    VALUES (?, 1)
                    `,
                    [url],
                    () => {

                        addLog(
                            `Yeni feed eklendi`
                        );

                        res.json({
                            success: true
                        });
                    }
                );
            }
        );
    }
);


/* =========================
   DELETE FEED
========================= */

app.delete(
    "/api/feeds/:id",
    authMiddleware,
    (req, res) => {

        db.run(
            `
            DELETE FROM feeds
            WHERE id = ?
            `,
            [req.params.id],
            () => {

                addLog(
                    "Feed silindi"
                );

                res.json({
                    success: true
                });
            }
        );
    }
);


/* =========================
   FETCH NEWS
========================= */

app.get(
    "/fetch-news",
    authMiddleware,
    async (req, res) => {

        await getTechNews();

        res.json({
            success: true
        });
    }
);


/* =========================
   SOCKET
========================= */

io.on("connection", () => {

    addLog(
        "Dashboard bağlandı"
    );
});


/* =========================
   TELEGRAM LOOP
========================= */

setInterval(() => {

    checkTelegramUpdates();

}, 5000);


/* =========================
   CRON
========================= */

cron.schedule(
    "*/30 * * * *",
    () => {

        addLog(
            "Otomatik RSS taraması başladı"
        );

        getTechNews();
    }
);


/* =========================
   SERVER
========================= */

server.listen(PORT, () => {

    console.log("");
    console.log("🚀 Server çalışıyor");
    console.log(`🌐 http://localhost:${PORT}`);
    console.log("");

    addLog(
        "Server başlatıldı"
    );
});


/* =========================
   FIRST RUN
========================= */

getTechNews();