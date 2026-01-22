
---

## GET /api/auth/me

Retrieves the profile information of the currently authenticated user.

### Request

**Headers**
- `Authorization: Bearer <ACCESS_TOKEN>` (string, required): The access token received during login or token refresh.

### Response

**200 OK**
Returns the user object of the authenticated user.
```json
{
  "statusCode": 200,
  "data": {
    "role": "user",
    "isActive": true,
    "_id": "60d5f2f5c7f8a8b2c8f8c5e4",
    "email": "user@example.com",
    "createdAt": "2023-01-15T12:00:00.000Z",
    "updatedAt": "2023-01-15T12:00:00.000Z"
  },
  "message": "User details fetched successfully"
}
```

### Errors

- **401 Unauthorized**:
  - If the access token is missing, invalid, or expired.
  ```json
  {
    "code": 401,
    "message": "Please authenticate"
  }
  ```
