import { Request, Response } from 'express';
import { asyncHandler } from '../utils/asyncHandler';
import appointmentService from '../services/appointment.service';
import { ApiResponse } from '../utils/ApiResponse';
import { IUser } from '../models/User.model';

const createAppointment = asyncHandler(async (req: Request, res: Response) => {
    const userId = (req.user as IUser)._id.toString();
    const appointment = await appointmentService.createAppointment(userId, req.body);
    
    res.status(201).json(
        new ApiResponse(201, appointment, 'Appointment created successfully')
    );
});

const getAppointments = asyncHandler(async (req: Request, res: Response) => {
    const userId = (req.user as IUser)._id.toString();
    const { status, startDate, endDate, limit, skip } = req.query;
    
    const options: any = {};
    if (status) options.status = status;
    if (startDate) options.startDate = new Date(startDate as string);
    if (endDate) options.endDate = new Date(endDate as string);
    if (limit) options.limit = parseInt(limit as string);
    if (skip) options.skip = parseInt(skip as string);
    
    const result = await appointmentService.getUserAppointments(userId, options);
    
    res.json(
        new ApiResponse(200, result, 'Appointments fetched successfully')
    );
});

const updateAppointment = asyncHandler(async (req: Request, res: Response) => {
    const userId = (req.user as IUser)._id.toString();
    const { id } = req.params;
    
    const appointment = await appointmentService.updateAppointment(id, userId, req.body);
    
    res.json(
        new ApiResponse(200, appointment, 'Appointment updated successfully')
    );
});

const cancelAppointment = asyncHandler(async (req: Request, res: Response) => {
    const userId = (req.user as IUser)._id.toString();
    const { id } = req.params;
    
    const appointment = await appointmentService.cancelAppointment(id, userId);
    
    res.json(
        new ApiResponse(200, appointment, 'Appointment cancelled successfully')
    );
});

const deleteAppointment = asyncHandler(async (req: Request, res: Response) => {
    const userId = (req.user as IUser)._id.toString();
    const { id } = req.params;
    
    await appointmentService.deleteAppointment(id, userId);
    
    res.json(
        new ApiResponse(200, null, 'Appointment deleted successfully')
    );
});

export default {
    createAppointment,
    getAppointments,
    updateAppointment,
    cancelAppointment,
    deleteAppointment
};