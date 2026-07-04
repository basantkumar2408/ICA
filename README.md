# ICA School Website v2
**Stack:** Node.js + Express · MongoDB Atlas · Cloudinary

---

## ⚡ Quick Start (Local)

```bash
# 1. Install dependencies
npm install

# 2. Setup environment
cp .env.example .env
# → .env file open karo, apni values fill karo

# 3. Run
npm start
# → http://localhost:3000
```

---

## 🌍 Deploy Kahan Bhi Karo

### Option 1 — Render (Free, Recommended)
1. [render.com](https://render.com) → New → Web Service
2. GitHub repo connect karo
3. Build Command: `npm install`
4. Start Command: `node server.js`
5. Environment Variables → `.env.example` se copy karke fill karo
6. Deploy ✅

### Option 2 — Railway
1. [railway.app](https://railway.app) → New Project → GitHub Repo
2. Variables tab me `.env.example` ki sab values dalo
3. Auto-deploy ✅

### Option 3 — Cyclic / Glitch
Same — repo upload karo, env vars set karo, done.

### Option 4 — VPS / Linux Server
```bash
git clone <your-repo>
cd ica-school-website
npm install
cp .env.example .env && nano .env   # fill values
node server.js

# Production ke liye PM2 use karo:
npm install -g pm2
pm2 start server.js --name ica-school
pm2 save && pm2 startup
```

### Option 5 — Docker
```bash
docker build -t ica-school .
docker run -p 3000:3000 --env-file .env ica-school
```

---

## 🔧 Environment Variables

| Variable | Description |
|---|---|
| `PORT` | Server port (default `3000`) |
| `MONGODB_URI` | MongoDB Atlas connection string |
| `MONGODB_DB` | Database name (`ica_school`) |
| `ADMIN_TOKEN` | Any long random secret string |
| `CLOUDINARY_CLOUD_NAME` | From Cloudinary dashboard |
| `CLOUDINARY_API_KEY` | From Cloudinary dashboard |
| `CLOUDINARY_API_SECRET` | From Cloudinary dashboard |

---

## 🗄️ MongoDB Atlas Setup

1. [cloud.mongodb.com](https://cloud.mongodb.com) → Free M0 cluster banao
2. Database Access → User add karo (username + password)
3. Network Access → `0.0.0.0/0` allow karo
4. Connect → Drivers → URI copy karo → `.env` me paste karo

**Seed initial settings (ek baar run karo — MongoDB Shell ya Compass):**
```js
use ica_school
db.settings.insertMany([
  { key: "admission_open", value: "false" },
  { key: "admission_year", value: "2026-27" },
  { key: "theme_primary",  value: "#c9982a" },
  { key: "theme_navy",     value: "#0a1628" }
])
```

---

## 👤 Admin Login

- Website open karo → **Admin** button click karo
- ID: `ICA24391174`
- Default Password: `admin@ICA2025` *(pehle login ke baad change karo)*
- Admin ID aur Password dono ab Admin Panel → Change Password se badle ja sakte hain.
- Naya password set karte waqt strong hona chahiye: minimum 8 characters, ek uppercase, ek lowercase, ek number aur ek special character.

## 🪪 ID Cards (Staff & Student)

- Sidebar → **Staff ID Cards**: Application Number se staff add/confirm karo — turant unique 6-digit Staff ID generate hota hai. Teaching / Non-Teaching filter, Block / Unblock / Remove / Delete, aur individual ya bulk ("Generate All") ID card print.
- Sidebar → **Student ID Cards**: Har confirmed student ko admission confirm hote hi unique 3-digit school-level Student ID mil jaata hai. Class/Section transfer (individual + bulk) aur ID card print (individual + bulk) yahin se hoti hai.
- Har card ke front side par photo, ID number, naam, designation/class, department/blood group; back side par sirf address print hota hai.

⚠️ **Security note:** Is zip me `.env` file nahi hai (sirf `.env.example`). Agar aapne pehle kabhi `.env` kisi ke saath share ki thi (jaise ki isme MongoDB URI aur Cloudinary keys the), unhe turant Atlas/Cloudinary dashboard se **rotate/change** kar lijiye, kyunki wo credentials expose ho chuke the.
