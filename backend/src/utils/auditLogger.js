const { supabaseAdmin } = require('../config/supabaseClient');

const logBubbleHistory = async (bubbleId, userId, action, oldData, newData, comment = null) => {
    try {
        // If running in a background job or bulk operation, we might want to await this.
        // Making it async but not blocking the main thread if not needed.
        const { error } = await supabaseAdmin
            .from('bubble_history')
            .insert({
                bubble_id: bubbleId,
                user_id: userId,
                action,
                old_data: oldData,
                new_data: newData,
                comment
            });

        if (error) {
            console.error('Error logging bubble history:', error);
        }
    } catch (err) {
        console.error('Unexpected error in logBubbleHistory:', err);
    }
};

module.exports = { logBubbleHistory };
