import { ArgumentsHost, Catch, ExceptionFilter, HttpException } from '@nestjs/common';
import { ZodError } from 'zod';
import type {Response} from 'express';
export class ApiError extends Error {constructor(public status:number,public code:string,message:string){super(message);}}
export function reject(status:number,code:string,message:string):never{throw new ApiError(status,code,message);}
@Catch()
export class SafeErrorFilter implements ExceptionFilter {
  catch(error:unknown,host:ArgumentsHost){const res=host.switchToHttp().getResponse<Response>();
    if(error instanceof ApiError){res.status(error.status).json({error:{code:error.code,message:error.message}});return;}
    if(error instanceof ZodError){res.status(400).json({error:{code:'VALIDATION',message:'输入格式无效，请检查日期、人数、预算及文本长度'}});return;}
    if(error instanceof HttpException){const status=error.getStatus();res.status(status).json({error:{code:status===404?'NOT_FOUND':'REQUEST_REJECTED',message:status===404?'未找到内容':'请求未被接受'}});return;}
    // Never log upstream errors, bodies, prompts, credentials or SQL parameter values.
    res.status(500).json({error:{code:'INTERNAL',message:'服务暂时无法处理请求，请稍后重试'}});
  }
}
