# Authentication System Documentation

This document explains the JWT-based authentication flow implemented in this project and highlights common security pitfalls that this design avoids.

---

### Summary of Implementation

The authentication system is built with the following principles:

- **Modularity:** Code is organized by feature into `models`, `routes`, `controllers`, `services`, `middleware`, and `config`.
- **Security:** Follows best practices for password hashing, token management, and data validation.
- **Scalability:** The structure is designed to be easily extended with more features and routes.

**Key Components:**
- **User Model:** Defines the user schema with Mongoose, including a pre-save hook for password hashing.
- **Token Model:** Stores refresh tokens in the database, allowing for proper invalidation and rotation.
- **JWT Service:** Handles the creation and verification of access and refresh tokens.
- **Auth Service:** Orchestrates the core logic for registration, login, logout, and token refresh.
- **Middleware:**
    - `auth`: Protects routes by verifying the access token.
    - `role`: Authorizes users based on their role (e.g., `admin`).
    - `validate`: Validates incoming request data against predefined schemas.
    - `errorHandler`: A global error handler to ensure consistent error responses.
- **Configuration:** Environment variables are managed via a central `config` module with `Joi` validation.

---

### Token Authentication Flow (Login → Access → Refresh)

The system uses a two-token strategy (access and refresh) to balance security and user experience.

1.  **Login:**
    - The user submits their `email` and `password` to the `POST /api/auth/login` endpoint.
    - The server validates the credentials.
    - If valid, the server generates two tokens:
        - A **short-lived Access Token** (e.g., 15 minutes). This token is sent in the response body and is intended for immediate use to access protected resources.
        - A **long-lived Refresh Token** (e.g., 7 days). This token is stored in the `Token` collection in the database and is also sent to the client as an **`httpOnly` cookie**.

2.  **Accessing Protected Resources:**
    - To access a protected route like `GET /api/auth/me`, the client must include the **Access Token** in the `Authorization` header as a Bearer token.
    - `Authorization: Bearer <access_token>`
    - The `auth` middleware intercepts the request, verifies the token's signature and expiration, and fetches the user from the database.
    - If the token is valid, the user's information is attached to the request object (`req.user`), and access is granted.
    - If the token is invalid or expired, a `401 Unauthorized` error is returned.

3.  **Refreshing the Access Token:**
    - When the Access Token expires, the client can no longer access protected routes.
    - The client sends a request to the `POST /api/auth/refresh` endpoint. This request automatically includes the **Refresh Token** from the `httpOnly` cookie.
    - The server:
        - Verifies the Refresh Token against the database.
        - Checks that it is not expired or blacklisted.
        - If valid, it generates a **new Access Token** and a **new Refresh Token** (token rotation).
        - The old Refresh Token is deleted from the database.
        - The new Access Token is sent in the response body, and the new Refresh Token is sent in a new `httpOnly` cookie.
    - The client can now use the new Access Token to continue making authenticated requests.

4.  **Logout:**
    - The client sends a request to `POST /api/auth/logout`.
    - The server receives the Refresh Token from the `httpOnly` cookie.
    - It finds and **deletes the Refresh Token** from the database, effectively invalidating the session.
    - The `httpOnly` cookie is cleared on the client side.

---

### Common Mistakes and How This Setup Avoids Them

1.  **Storing Passwords in Plain Text:**
    - **Mistake:** Saving user passwords directly in the database. A database breach would expose all user credentials.
    - **Solution:** We use `bcrypt` to **hash and salt** passwords before saving them. The `User.model.ts` file includes a `pre-save` hook that automatically hashes the password. `bcrypt` is a one-way algorithm, making it computationally infeasible to reverse the hash.

2.  **Using Long-Lived Access Tokens:**
    - **Mistake:** Creating access tokens that last for days or weeks. If an access token is stolen, an attacker has a long window to impersonate the user.
    - **Solution:** Access tokens are **short-lived** (15 minutes). This drastically reduces the window of opportunity for an attacker if a token is compromised.

3.  **Insecure Refresh Token Storage:**
    - **Mistake:** Storing the refresh token in `localStorage` on the client-side. This makes it vulnerable to XSS (Cross-Site Scripting) attacks, where a malicious script could steal the token.
    - **Solution:** The refresh token is sent as an **`httpOnly` cookie**. This prevents any JavaScript running on the client from accessing it, providing a strong defense against XSS.

4.  **No Refresh Token Invalidation:**
    - **Mistake:** Creating refresh tokens that never expire or cannot be invalidated on the server-side. If a refresh token is stolen, it can be used indefinitely.
    - **Solution:**
        - **Database Storage:** Refresh tokens are stored in a dedicated MongoDB collection. This allows us to **invalidate them on logout** by simply deleting the token from the database.
        - **Token Rotation:** On every refresh, a **new refresh token is generated**, and the old one is deleted. This means that even if a refresh token is stolen, it can only be used once. If the legitimate user and an attacker both try to use it, one of them will fail, which can be a signal of a compromised account.

5.  **Leaking Sensitive Information in Error Messages:**
    - **Mistake:** Sending detailed error messages or stack traces to the client (e.g., "Failed to connect to database: [connection string]"). This can reveal internal system architecture.
    - **Solution:** The global `errorHandler` middleware catches all errors and sends a standardized, generic error message in production. Detailed stack traces are only logged on the server and are not exposed to the client.

6.  **No Input Validation:**
    - **Mistake:** Trusting user input and passing it directly to services or database queries. This can lead to NoSQL injection, crashes, or unexpected behavior.
    - **Solution:** We use `Joi` in the `validate` middleware to enforce a strict schema on all incoming request bodies, query parameters, and cookies. Any request with invalid data is rejected with a `400 Bad Request` error before it reaches the business logic.
