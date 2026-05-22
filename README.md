# 🚀 InfluxDB Chatbot WebApp

A modern chatbot-based monitoring and visualization web application built with Node.js, InfluxDB, Telegraf, and a clean interactive UI.

## 📌 Overview

This project provides a web-based chatbot interface to interact with industrial/PLC data stored inside InfluxDB.
It combines real-time monitoring, chatbot interactions, and data visualization into a single lightweight application.

The application is designed to:

* Monitor PLC/industrial data
* Interact with InfluxDB
* Display live metrics
* Provide a chatbot-driven UI
* Simplify industrial data access

---

# ✨ Features

✅ Real-time InfluxDB integration
✅ Interactive chatbot interface
✅ Modern responsive web UI
✅ PLC connectivity support
✅ Telegraf integration
✅ Lightweight Node.js backend
✅ Easy deployment using Docker/ngrok/Render
✅ Clean modular architecture

---

# 🛠️ Tech Stack

| Technology          | Purpose                 |
| ------------------- | ----------------------- |
| Node.js             | Backend Server          |
| InfluxDB            | Time-Series Database    |
| Telegraf            | Metrics Collection      |
| HTML/CSS/JavaScript | Frontend UI             |
| WebSocket           | Real-time Communication |

---

# 📂 Project Structure

```bash
Influxdb_chatbot_webapp/
│
├── public/
│   ├── index.html
│   ├── styles.css
│   └── app.js
│
├── telegraf/
│   └── telegraf.conf
│
├── node_modules/
├── package.json
├── package-lock.json
├── chatbot_ui_server.js
├── show_influx.js
├── PLC_gadget.js
└── README.md
```

---

# ⚙️ Installation

## 1️⃣ Clone Repository

```bash
git clone https://github.com/mahataventury-lab/Influxdb_chatbot_webapp.git
```

## 2️⃣ Navigate to Project

```bash
cd Influxdb_chatbot_webapp
```

## 3️⃣ Install Dependencies

```bash
npm install
```

## 4️⃣ Start Application

```bash
node chatbot_ui_server.js
```

---

# 🌐 Running the Application

After starting the server, open:

```bash
http://localhost:3000
```

---

# 🐳 Docker Support

This project can also be containerized using Docker for easier deployment and scalability.

---

# ☁️ Deployment

Recommended platforms:

* Render
* Railway
* Vercel
* Docker + ngrok

---

# 🔒 Security Notes

* Keep API keys and credentials inside `.env`
* Never push sensitive credentials to GitHub
* Use `.gitignore` properly

---

# 📈 Future Improvements

* Authentication system
* Advanced analytics dashboard
* AI-powered chatbot integration
* Role-based access
* Mobile-friendly dashboard
* Cloud deployment pipeline

---

# 👨‍💻 Author

Developed by Tania Mahata

---

# 📄 License

This project is intended for internal development and learning purposes.
