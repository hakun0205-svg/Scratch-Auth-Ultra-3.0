# Scratch-Auth-Ultra-3.0

Scratchパスワードを使わずに、Scratchアカウントを認証するサービスです。  
コメント認証・クラウド変数認証の2方式に対応しています。

---

## 目次

- [特徴](#特徴)
- [仕組み](#仕組み)
- [セットアップ](#セットアップ)
- [環境変数](#環境変数)
- [API リファレンス](#api-リファレンス)
- [管理者ダッシュボード](#管理者ダッシュボード)
- [Webhook](#webhook)

---

## 特徴

| 機能 | 説明 |
|---|---|
| 💬 コメント認証 | Scratchプロジェクトのコメント欄にコードを投稿して認証 |
| ☁️ クラウド変数認証 | Scratchのクラウド変数にコードをセットして認証 |
| ⚡ クイックサインイン | 前回のユーザー名を記憶して1クリック認証 |
| 🛡️ レートリミット | IP別のリクエスト制限でブルートフォースを防止 |
| 🔔 Webhook通知 | 認証成功時に任意のURLへPOSTリクエストを送信 |
| ⚙️ 管理者ダッシュボード | セッション・ペンディング・認証ログを一覧 |

---

## 仕組み

```
ユーザー           Scratch Auth            Scratch
   │                    │                     │
   │── ユーザー名送信 ──>│                     │
   │                    │── ユーザー確認 ─────>│
   │<─ 認証コード(12桁)─│                     │
   │                    │                     │
   │── コメント or クラウド変数にコードを投稿 ─>│
   │                    │                     │
   │── 認証確認リクエスト>│                     │
   │                    │<── コメント/ログ確認 ─│
   │<─ セッショントークン│                     │
```

1. ユーザーがScratchユーザー名を入力
2. サーバーが12桁のランダムな認証コードを発行
3. ユーザーがScratchプロジェクトでコードを送信（コメントorクラウド変数）
4. サーバーがScratch APIでコードを検証
5. 成功したらセッショントークン（有効期限24時間）を発行

---

## セットアップ

### 必要環境

- Node.js 18以上

### インストール

```bash
# リポジトリをクローン or ファイルを配置
git clone https://github.com/hakun0205-svg/Scratch-Auth-Ultra-3.0
cd scratch-auth-ultra

# 依存パッケージをインストール
npm install

# 環境変数を設定
cp .env.example .env
# .env を編集（後述の環境変数を参照）
```

### 起動

```bash
# 本番
npm start

# 開発（ファイル変更を検知して自動再起動）
npm run dev
```

### ファイル構成

```
scratch-auth-ultra/
├── server.js          # バックエンド（Express）
├── public/
│   ├── index.html     # ユーザー向けUI
│   └── admin.html     # 管理者ダッシュボード
├── package.json
└── .env               # 環境変数（要作成）
```

> `public/` フォルダがない場合は作成してください。`index.html` と `admin.html` を置きます。

---

## 環境変数

`.env` ファイルに以下を設定します。

```env
# サーバーのポート番号（デフォルト: 3000）
PORT=3000

# 認証に使うScratchプロジェクトのID
PROJECT_ID=1374729902

# プロジェクトオーナーのScratchユーザー名
PROJECT_OWNER=mahiro0622

# クラウド変数認証で使う変数名（"☁ " は自動付与）
CLOUD_VARIABLE=auth_code

# 認証コードの有効期限（秒、デフォルト: 600）
CODE_EXPIRE_SECONDS=600

# クラウドログの取得上限（最大100）
CLOUD_LOG_LIMIT=100

# 管理者ダッシュボード用キー（未設定で管理者機能が無効）
ADMIN_KEY=your-secret-admin-key-here

# Webhook通知先URL（未設定でWebhook機能が無効）
WEBHOOK_URL=https://your-server.example.com/webhook
```

### PROJECT_ID の調べ方

Scratchプロジェクトの URL に含まれる数字が PROJECT_ID です。

```
https://scratch.mit.edu/projects/【ここ】/
```

---

## API リファレンス

ベースURL: `http://localhost:3000`

### ヘルスチェック

```
GET /api/health
```

```json
{
  "success": true,
  "status": "online",
  "service": "Scratch Auth Ultra",
  "projectId": "1374729902",
  "cloudVariable": "☁ auth_code",
  "timestamp": "2025-01-01T00:00:00.000Z"
}
```

---

### 認証開始

```
POST /api/auth/start
```

**リクエスト**

```json
{
  "username": "Scratchユーザー名",
  "method": "comment"
}
```

| フィールド | 型 | 説明 |
|---|---|---|
| `username` | string | ScratchユーザーID（必須） |
| `method` | string | `"comment"` または `"cloud"`（省略時: comment） |

**レスポンス（成功）**

```json
{
  "success": true,
  "username": "mahiro0622",
  "userId": 12345678,
  "method": "comment",
  "code": "384920173645",
  "expiresAt": 1735689600000,
  "expiresIn": 600,
  "projectId": "1374729902",
  "projectUrl": "https://scratch.mit.edu/projects/1374729902/",
  "cloudVariable": "☁ auth_code",
  "message": "Scratchプロジェクトにコードをコメントしてください。"
}
```

> **レートリミット:** IP別 10回/分。超過時は `429 Too Many Requests` を返します。

---

### 認証確認

```
POST /api/auth/check
```

**リクエスト**

```json
{
  "username": "mahiro0622"
}
```

**レスポンス（認証成功）**

```json
{
  "success": true,
  "authenticated": true,
  "status": "AUTHENTICATED",
  "method": "comment",
  "sessionToken": "a1b2c3d4...",
  "user": {
    "username": "mahiro0622",
    "id": 12345678
  },
  "message": "Scratch Authに成功しました。"
}
```

**レスポンス（待機中）**

```json
{
  "success": true,
  "authenticated": false,
  "status": "WAITING",
  "message": "💬 認証コメントを待っています…"
}
```

> **レートリミット:** IP別 60回/分。

---

### セッション確認

```
GET /api/auth/me
Authorization: Bearer <sessionToken>
```

**レスポンス（有効なセッション）**

```json
{
  "success": true,
  "authenticated": true,
  "user": {
    "username": "mahiro0622",
    "id": 12345678
  },
  "method": "comment",
  "expiresAt": 1735776000000
}
```

---

### ログアウト

```
POST /api/auth/logout
Authorization: Bearer <sessionToken>
```

```json
{
  "success": true
}
```

---

### Scratchユーザー情報

```
GET /api/scratch/user/:username
```

Scratch APIのユーザー情報をそのままプロキシします。

---

### プロジェクト情報

```
GET /api/project
```

```json
{
  "success": true,
  "project": {
    "id": "1374729902",
    "title": "プロジェクト名",
    "author": "mahiro0622",
    "thumbnail": "https://uploads.scratch.mit.edu/projects/thumbnails/1374729902.png",
    "url": "https://scratch.mit.edu/projects/1374729902/"
  }
}
```

---

## 管理者ダッシュボード

`ADMIN_KEY` を設定すると、`/admin.html` から管理者ダッシュボードにアクセスできます。

### 機能

- **統計** — アクティブセッション数・認証待機数・認証ログ件数をリアルタイム表示
- **セッション一覧** — 現在ログイン中のユーザーを確認、セッションを手動で失効可能
- **認証待機一覧** — 認証コードを発行したが未完了のユーザーを確認
- **認証ログ** — 今回の起動以降の認証成功履歴（最大200件）を表示
- **自動更新** — 15秒ごとに自動で最新データを取得

### 管理者API

管理者APIはすべて `Authorization: Bearer <ADMIN_KEY>` ヘッダーが必要です。

```
GET /api/admin/stats
```

```
DELETE /api/admin/sessions/:tokenPrefix
```

---

## Webhook

`WEBHOOK_URL` を設定すると、認証成功のたびに以下の形式でPOSTリクエストが送信されます。

```json
{
  "event": "auth_success",
  "username": "mahiro0622",
  "userId": 12345678,
  "method": "comment",
  "timestamp": "2025-01-01T00:00:00.000Z"
}
```

Webhook送信に失敗してもサーバーは停止しません（エラーはサーバーログに記録）。

### Discord Webhookの例

Discord の Incoming Webhook URL をそのまま `WEBHOOK_URL` に設定することはできません。Discordが期待するJSON形式（`content` フィールド）が異なるためです。中継サーバーか、[Make](https://make.com) / [Zapier](https://zapier.com) などのサービスを挟んでください。

---

## エラーコード一覧

| コード | 説明 |
|---|---|
| `INVALID_USERNAME` | ユーザー名の形式が正しくない |
| `USER_NOT_FOUND` | Scratchにそのユーザーが存在しない |
| `AUTH_NOT_FOUND` | 認証コードが存在しないか期限切れ |
| `AUTH_EXPIRED` | 認証コードの有効期限が切れた |
| `RATE_LIMITED` | リクエストが多すぎる |
| `AUTH_START_ERROR` | 認証開始時にサーバーエラー |
| `AUTH_CHECK_ERROR` | 認証確認時にサーバーエラー |
| `ADMIN_DISABLED` | ADMIN_KEYが設定されていない |
| `UNAUTHORIZED` | 管理者キーが正しくない |
