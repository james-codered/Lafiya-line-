app.post('/api/vaccinations', requireAuth, staff('system_admin', 'facility_admin', 'health_worker'), async (req, res) => {
  let appointmentId, callIds = [];

  try {
    const { childId, dose, nextDoseDate } = req.body || {};
    const stage = stageMap[dose];

    if (!stage) return fail(res, 400, 'Choose the dose given today.');

    const isFinalDose = dose === '15 months';

    if (!isFinalDose && (
      !/^\d{4}-\d{2}-\d{2}$/.test(nextDoseDate || '') ||
      Number.isNaN(Date.parse(nextDoseDate + 'T12:00:00+01:00')) ||
      nextDoseDate <= new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Africa/Lagos',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit'
      }).format(new Date())
    )) {
      return fail(res, 400, 'Choose a future date for the next dose.');
    }

    const { data: child, error: childError } = await supabase
      .from('children')
      .select('id,caregiver_id')
      .eq('id', childId)
      .single();

    if (childError || !child) {
      return fail(res, 404, 'Child not found at your facility.');
    }

    const { data: caregiver, error: caregiverError } = await supabase
      .from('caregivers')
      .select('id,facility_id,consent_given,consent_withdrawn_at,preferred_language,phone')
      .eq('id', child.caregiver_id)
      .single();

    if (caregiverError || !caregiver || !hasFacility(req.profile, caregiver.facility_id)) {
      return fail(res, 404, 'Child not found at your facility.');
    }

    if (!caregiver.phone && caregiver.consent_given && !caregiver.consent_withdrawn_at) {
      return fail(res, 409, 'This caregiver’s number has been deleted; update the record before continuing.');
    }

    const { data: duplicate, error: duplicateError } = await supabase
      .from('appointment')
      .select('id')
      .eq('child_id', child.id)
      .eq('vaccine_type', stage[0])
      .maybeSingle();

    if (duplicateError) throw duplicateError;

    if (duplicate) {
      return fail(res, 409, 'This dose stage is already recorded for this child.');
    }

    const now = new Date();
    const dueAt = isFinalDose
      ? null
      : new Date(nextDoseDate + 'T12:00:00+01:00').toISOString();

    const saved = await saveVaccination({
      p_child_id: child.id,
      p_vaccine_type: stage[0],
      p_vaccinated_at: now.toISOString(),
      p_next_dose_stage: isFinalDose ? null : stage[1],
      p_next_dose_due_at: dueAt,
      p_schedule_complete: isFinalDose,
      p_schedule_completed_at: isFinalDose ? now.toISOString() : null,
      p_recorded_by: req.profile.id,
      p_language_code: caregiver.preferred_language,
      p_create_calls: Boolean(
        caregiver.phone &&
        caregiver.consent_given &&
        !caregiver.consent_withdrawn_at
      )
    });

    appointmentId = saved.appointment_id;
    callIds = saved.call_ids || [];

    if (isFinalDose) {
      await maybeDeleteCaregiverPhone(caregiver.id);
    }

    return res.status(201).json({
      success: true,
      appointment_id: appointmentId,
      call_ids: callIds
    });

  } catch (error) {
    console.error('Vaccination save error:', {
      message: error.message,
      code: error.code,
      details: error.details,
      hint: error.hint
    });

    if (callIds.length) {
      await supabase.from('calls').delete().in('id', callIds);
    }

    if (appointmentId) {
      await supabase.from('appointment').delete().eq('id', appointmentId);
    }

    return fail(res, 400, error.message || 'Could not save this vaccination.');
  }
});
