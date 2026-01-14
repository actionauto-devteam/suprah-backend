class ApiError extends Error {
    constructor(
      public statusCode: number,
      public message: string = "Something went wrong",
      public errors: any[] = [],
      public stack: string = ""
    ) {
      super(message);
      this.statusCode = statusCode;
      this.data = null;
      this.message = message;
      this.success = false;
      this.errors = errors;
  
      if (stack) {
        this.stack = stack;
      } else {
        Error.captureStackTrace(this, this.constructor);
      }
    }
  
    public success: boolean;
    public data: null;
  }
  
  export { ApiError };
  