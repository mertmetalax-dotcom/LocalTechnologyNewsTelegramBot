const sqlite3 = require("sqlite3").verbose();

const db = new sqlite3.Database("./news.db");

db.serialize(() => {

    /* NEWS */

    db.run(`
        CREATE TABLE IF NOT EXISTS news (

            id INTEGER PRIMARY KEY AUTOINCREMENT,

            title TEXT,

            link TEXT UNIQUE,

            source TEXT,

            description TEXT,

            image TEXT,

            category TEXT,

            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    `);


    /* FEEDS */

    db.run(`
        CREATE TABLE IF NOT EXISTS feeds (

            id INTEGER PRIMARY KEY AUTOINCREMENT,

            url TEXT UNIQUE,

            active INTEGER DEFAULT 1
        )
    `);


    /* USERS */

    db.run(`
        CREATE TABLE IF NOT EXISTS users (

            id INTEGER PRIMARY KEY AUTOINCREMENT,

            chat_id TEXT UNIQUE,

            username TEXT,

            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    `);


    /* DEFAULT FEEDS */

    const defaultFeeds = [

        "https://techcrunch.com/feed/",
        "https://www.theverge.com/rss/index.xml",
        "https://www.wired.com/feed/rss",
        "https://webrazzi.com/feed/",
        "https://shiftdelete.net/feed",
        "https://www.donanimhaber.com/rss/tum/"
    ];

    defaultFeeds.forEach(feed => {

        db.run(
            `
            INSERT OR IGNORE INTO feeds (url)
            VALUES (?)
            `,
            [feed]
        );
    });

    console.log("Database hazır");
});

module.exports = db;