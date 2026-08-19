# Hướng Dẫn Deploy Game Sâm Lốc Online (Node.js + Socket.IO)

Game Sâm Lốc Online là một ứng dụng **Full-stack Node.js thời gian thực sử dụng WebSocket (Socket.IO)** để quản lý phòng chơi, chia bài và đồng bộ lượt đánh. 

> [!IMPORTANT]
> Vì game sử dụng **kết nối WebSocket liên tục (persistent connection)** và lưu trữ trạng thái phòng trong bộ nhớ (in-memory state), bạn **không nên dùng** các nền tảng serverless tĩnh như GitHub Pages hoặc Vercel (vì serverless sẽ ngắt kết nối WebSocket). Thay vào đó, hãy sử dụng các nền tảng PaaS hoặc VPS chuyên dụng dưới đây.

---

## Cách 1: Deploy lên Render.com (Khuyên dùng - Miễn phí & Cực dễ)

Render cung cấp gói **Free Web Service** hỗ trợ Node.js và WebSocket trơn tru:

1. Đưa mã nguồn lên GitHub:
   ```bash
   git remote add origin https://github.com/<username>/<repo-name>.git
   git branch -M main
   git push -u origin main
   ```
2. Truy cập [Render.com](https://render.com) và đăng nhập (bằng GitHub).
3. Nhấp vào nút **New +** -> Chọn **Web Service**.
4. Chọn repository GitHub chứa dự án này.
5. Cấu hình thông số:
   - **Name**: `sam-loc-online` (hoặc tên tùy chọn)
   - **Region**: Singapore (gần Việt Nam, độ trễ thấp nhất)
   - **Branch**: `main` (hoặc `master`)
   - **Runtime**: `Node`
   - **Build Command**: `npm install`
   - **Start Command**: `npm start` (hoặc `node server.js`)
   - **Instance Type**: `Free`
6. Nhấp **Create Web Service**. 
7. Render sẽ tự động build và cấp cho bạn một domain HTTPS (ví dụ: `https://sam-loc-online.onrender.com`). Bạn có thể gửi link này cho bạn bè để cùng chơi!

---

## Cách 2: Deploy lên Railway.app

1. Đăng ký tài khoản tại [Railway.app](https://railway.app).
2. Chọn **New Project** -> **Deploy from GitHub repo**.
3. Chọn repo của bạn. Railway sẽ tự động nhận diện file `package.json` hoặc `Dockerfile` và deploy ngay lập tức.
4. Vào tab **Settings** -> Mục **Networking** -> Nhấp **Generate Domain** để nhận đường link chơi game online.

---

## Cách 3: Deploy lên Fly.io (Sử dụng Dockerfile có sẵn)

1. Cài đặt [Flyctl CLI](https://fly.io/docs/hands-on/install-flyctl/).
2. Chạy lệnh:
   ```bash
   fly launch
   fly deploy
   ```
3. Fly.io sẽ tự động build từ file `Dockerfile` đã được tạo sẵn trong project.

---

## Cách 4: Tự Deploy lên máy chủ riêng (VPS Ubuntu / Linux)

Nếu bạn có VPS riêng (DigitalOcean, Vultr, AWS, Linode, OVH...):

1. Cài đặt Node.js và PM2:
   ```bash
   curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
   sudo apt-get install -y nodejs
   sudo npm install -g pm2
   ```
2. Clone repo về VPS:
   ```bash
   git clone <link-repo> /var/www/samloc
   cd /var/www/samloc
   npm install --production
   ```
3. Chạy server ở chế độ nền với PM2:
   ```bash
   pm2 start server.js --name "samloc-game"
   pm2 save
   pm2 startup
   ```
4. Cấu hình Nginx làm Reverse Proxy với WebSocket:
   ```nginx
   server {
       listen 80;
       server_name game.yourdomain.com;

       location / {
           proxy_pass http://localhost:3000;
           proxy_http_version 1.1;
           proxy_set_header Upgrade $http_upgrade;
           proxy_set_header Connection 'upgrade';
           proxy_set_header Host $host;
           proxy_cache_bypass $http_upgrade;
       }
   }
   ```
5. Kích hoạt chứng chỉ SSL miễn phí với Certbot:
   ```bash
   sudo certbot --nginx -d game.yourdomain.com
   ```
