# API Examples

This document provides example `curl` commands and JSON responses for the authentication endpoints.

**Note for Windows Users:** The `curl` examples for `POST` requests have been adapted for Windows Command Prompt (`cmd.exe`). In `cmd.exe`, you must use double quotes (`"`) for the outer shell and escape the inner double quotes with a backslash (`\"`). If you are using a different shell like Git Bash or PowerShell, you might be able to use the Unix-style single quotes (`'`) as originally shown.

---

### 1. Register a New User

**Request (Windows CMD):**
```bash
curl -X POST http://localhost:5000/api/auth/register \
-H "Content-Type: application/json" \
-d "{
  \"email\": \"testuser@example.com\",
  \"password\": \"password123\",
  \"role\": \"user\"
}"
```

**Request (Unix/macOS/Git Bash):**
```bash
curl -X POST http://localhost:5000/api/auth/register \
-H "Content-Type: application/json" \
-d '{
  "email": "testuser@example.com",
  "password": "password123",
  "role": "user"
}'
```

**Response (201 Created):**
```json
{
  "statusCode": 201,
  "data": {
    "user": {
      "role": "user",
      "isActive": true,
      "_id": "60d5f2f5c7f8a8b2c8f8c5e4",
      "email": "testuser@example.com",
      "createdAt": "2023-01-15T12:00:00.000Z",
      "updatedAt": "2023-01-15T12:00:00.000Z"
    },
    "tokens": {
      "access": {
        "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
        "expires": "2023-01-15T12:15:00.000Z"
      },
      "refresh": {
        "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
        "expires": "2023-01-22T12:00:00.000Z"
      }
    }
  },
  "message": "User registered successfully"
}
```

---

### 2. Login

**Request (Windows CMD):**
```bash
curl -X POST http://localhost:5000/api/auth/login \
-H "Content-Type: application/json" \
-d "{
  \"email\": \"testuser@example.com\",
  \"password\": \"password123\"
}" -c cookies.txt
```

**Request (Unix/macOS/Git Bash):**
```bash
curl -X POST http://localhost:5000/api/auth/login \
-H "Content-Type: application/json" \
-d '{
  "email": "testuser@example.com",
  "password": "password123"
}' -c cookies.txt
```

**Response (200 OK):**
```json
{
  "statusCode": 200,
  "data": {
    "user": {
      "role": "user",
      "isActive": true,
      "_id": "60d5f2f5c7f8a8b2c8f8c5e4",
      "email": "testuser@example.com",
      "createdAt": "2023-01-15T12:00:00.000Z",
      "updatedAt": "2023-01-15T12:00:00.000Z"
    },
    "tokens": {
      "access": {
        "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
        "expires": "2023-01-15T12:30:00.000Z"
      },
      "refresh": {
        "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
        "expires": "2023-01-22T12:15:00.000Z"
      }
    }
  },
  "message": "Login successful"
}
```
*Note: The `refreshToken` is stored in an HTTP-only cookie (`cookies.txt` if using curl with `-c`).*

---

### 3. Get User Profile (Protected Route)

**Request:**
```bash
# Replace <ACCESS_TOKEN> with the token from the login response
curl -X GET http://localhost:5000/api/auth/me \
-H "Authorization: Bearer <ACCESS_TOKEN>"
```

**Response (200 OK):**
```json
{
  "statusCode": 200,
  "data": {
    "role": "user",
    "isActive": true,
    "_id": "60d5f2f5c7f8a8b2c8f8c5e4",
    "email": "testuser@example.com",
    "createdAt": "2023-01-15T12:00:00.000Z",
    "updatedAt": "2023-01-15T12:00:00.000Z"
  },
  "message": "User details fetched successfully"
}
```

---

### 4. Refresh Tokens

**Request:**
```bash
# This request uses the HTTP-only cookie containing the refresh token
curl -X POST http://localhost:5000/api/auth/refresh \
-b cookies.txt -c cookies.txt
```

**Response (200 OK):**
```json
{
    "statusCode": 200,
    "data": {
        "access": {
            "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
            "expires": "2023-01-15T12:45:00.000Z"
        },
        "refresh": {
            "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
            "expires": "2023-01-22T12:30:00.000Z"
        }
    },
    "message": "Tokens refreshed successfully"
}
```
*Note: A new `refreshToken` is issued and replaces the old one in the HTTP-only cookie.*

---

### 5. Logout

**Request:**
```bash
curl -X POST http://localhost:5000/api/auth/logout \
-b cookies.txt
```

**Response (200 OK):**
```json
{
  "statusCode": 200,
  "data": {},
  "message": "Logout successful"
}
```
*Note: This invalidates the refresh token in the database and clears the cookie.*
